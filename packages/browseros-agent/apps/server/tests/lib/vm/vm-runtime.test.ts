/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '../../../src/lib/logger'
import { VmNotReadyError } from '../../../src/lib/vm/errors'
import type { VmManifest } from '../../../src/lib/vm/manifest'
import {
  getCachedManifestPath,
  getContainerdSocketPath,
  getInstalledManifestPath,
  VM_NAME,
} from '../../../src/lib/vm/paths'
import { VM_TELEMETRY_EVENTS } from '../../../src/lib/vm/telemetry'
import { VmRuntime } from '../../../src/lib/vm/vm-runtime'
import { fakeLimactl } from '../../__helpers__/fake-limactl'
import { fakeSsh } from '../../__helpers__/fake-ssh'

const manifest: VmManifest = {
  schemaVersion: 2,
  updatedAt: '2026-04-22T00:00:00.000Z',
  agents: {
    openclaw: {
      image: 'ghcr.io/openclaw/openclaw',
      version: '2026.4.12',
      tarballs: {
        arm64: {
          key: 'vm/images/openclaw-2026.4.12-arm64.tar.gz',
          sha256: 'agent-arm',
          sizeBytes: 1,
        },
        x64: {
          key: 'vm/images/openclaw-2026.4.12-x64.tar.gz',
          sha256: 'agent-x64',
          sizeBytes: 1,
        },
      },
    },
  },
}

describe('VmRuntime', () => {
  let root: string
  let limaHome: string
  let logPath: string
  let templatePath: string
  let socketServer: ReturnType<typeof Bun.listen> | null

  beforeEach(async () => {
    root = await mkdtemp('/tmp/vmrt-')
    limaHome = join(root, 'lima')
    logPath = join(root, 'limactl.log')
    templatePath = join(root, 'browseros-vm.yaml')
    socketServer = null
    await writeCachedManifest(root)
    await writeFile(templatePath, 'minimumLimaVersion: 2.0.0\nmounts: []\n')
  })

  afterEach(async () => {
    socketServer?.stop(true)
    await rm(root, { recursive: true, force: true })
  })

  it('provisions a fresh VM, waits for the socket, and installs the manifest', async () => {
    const limactlPath = await fakeLimactl(
      { list: { stdout: '' }, create: {}, start: {} },
      logPath,
    )
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      templatePath,
      browserosRoot: root,
    })
    socketServer = await createSocket(getContainerdSocketPath(root))

    await runtime.ensureReady()

    const log = await readFile(logPath, 'utf8')
    expect(log).toContain(`ARGS:create --tty=false --name=${VM_NAME}`)
    expect(log).toContain(`ARGS:start --tty=false ${VM_NAME}`)
    await expect(
      readFile(getInstalledManifestPath(root), 'utf8'),
    ).resolves.toContain(manifest.updatedAt)
    await expect(
      readFile(join(limaHome, `${VM_NAME}.yaml`), 'utf8'),
    ).resolves.toContain('mountPoint: "/mnt/browseros/vm"')
  })

  it('returns fast when the VM is already running and manifests match', async () => {
    await writeInstalledManifest(root)
    const limactlPath = await fakeLimactl(
      {
        list: {
          stdout: JSON.stringify([
            { name: VM_NAME, status: 'Running', dir: limaHome },
          ]),
        },
        create: { stderr: 'should not create', exit: 9 },
        start: { stderr: 'should not start', exit: 9 },
      },
      logPath,
    )
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      browserosRoot: root,
    })
    socketServer = await createSocket(getContainerdSocketPath(root))

    await runtime.ensureReady()

    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('ARGS:list --format json')
    expect(log).not.toContain('ARGS:create')
    expect(log).not.toContain('ARGS:start')
  })

  it('starts an existing stopped VM without recreating it', async () => {
    await writeInstalledManifest(root)
    const limactlPath = await fakeLimactl(
      {
        list: {
          stdout: JSON.stringify([
            { name: VM_NAME, status: 'Stopped', dir: limaHome },
          ]),
        },
        start: {},
      },
      logPath,
    )
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      browserosRoot: root,
    })
    socketServer = await createSocket(getContainerdSocketPath(root))

    await runtime.ensureReady()

    const log = await readFile(logPath, 'utf8')
    expect(log).toContain(`ARGS:start --tty=false ${VM_NAME}`)
    expect(log).not.toContain('ARGS:create')
  })

  it('recreates an existing VM that does not have the containerd runtime marker', async () => {
    await writeInstalledManifest(root)
    const limactlPath = await fakeLimactl(
      {
        list: {
          stdout: JSON.stringify([
            { name: VM_NAME, status: 'Running', dir: limaHome },
          ]),
        },
        stop: {},
        delete: {},
        create: {},
        start: {},
      },
      logPath,
    )
    const sshPath = await fakeSsh({ stdout: 'provisioned:old\n' }, logPath)
    await mkdir(join(limaHome, VM_NAME), { recursive: true })
    await writeFile(join(limaHome, VM_NAME, 'ssh.config'), '')
    setTimeout(() => {
      void createSocket(getContainerdSocketPath(root)).then((server) => {
        socketServer = server
      })
    }, 10)
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      sshPath,
      templatePath,
      browserosRoot: root,
    })

    await runtime.ensureReady()

    const log = await readFile(logPath, 'utf8')
    expect(log).toContain(`ARGS:stop ${VM_NAME}`)
    expect(log).toContain(`ARGS:delete --force ${VM_NAME}`)
    expect(log).toContain(`ARGS:create --tty=false --name=${VM_NAME}`)
    expect(log).toContain(`ARGS:start --tty=false ${VM_NAME}`)
  })

  it('treats stopVm as idempotent when the VM is already stopped', async () => {
    const limactlPath = await fakeLimactl(
      { stop: { stderr: 'instance is not running', exit: 1 } },
      logPath,
    )
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      browserosRoot: root,
    })

    await expect(runtime.stopVm()).resolves.toBeUndefined()
  })

  it('requires a bundled Lima template for fresh VM provisioning', async () => {
    const limactlPath = await fakeLimactl({ list: { stdout: '' } }, logPath)
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      browserosRoot: root,
    })

    await expect(runtime.ensureReady()).rejects.toThrow('Lima template path')
  })

  it('throws VmNotReadyError when the socket never appears', async () => {
    const limactlPath = await fakeLimactl(
      { list: { stdout: '' }, create: {}, start: {} },
      logPath,
    )
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      templatePath,
      browserosRoot: root,
      socketTimeoutMs: 10,
      socketPollMs: 1,
    })

    await expect(runtime.ensureReady()).rejects.toThrow(VmNotReadyError)
  })

  it('exposes a reset stub with a follow-up-plan message', async () => {
    const limactlPath = await fakeLimactl({}, logPath)
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      browserosRoot: root,
    })

    await expect(runtime.reset('bad disk')).rejects.toThrow(
      'VmRuntime.reset is not implemented yet',
    )
  })

  it('logs upgrade mismatch and preserves the installed manifest until upgrade happens', async () => {
    await writeInstalledManifest(root, '2026-04-21T00:00:00.000Z')
    const limactlPath = await fakeLimactl(
      {
        list: {
          stdout: JSON.stringify([
            { name: VM_NAME, status: 'Running', dir: limaHome },
          ]),
        },
      },
      logPath,
    )
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      templatePath,
      browserosRoot: root,
    })
    socketServer = await createSocket(getContainerdSocketPath(root))
    const originalWarn = logger.warn
    const warnings: Array<{
      message: string
      meta?: Record<string, unknown>
    }> = []
    logger.warn = (message, meta) => warnings.push({ message, meta })

    try {
      await runtime.ensureReady()
    } finally {
      logger.warn = originalWarn
    }

    expect(warnings).toContainEqual({
      message: VM_TELEMETRY_EVENTS.upgradeDetected,
      meta: {
        from: '2026-04-21T00:00:00.000Z',
        to: '2026-04-22T00:00:00.000Z',
      },
    })
    expect(await readInstalledUpdatedAt(root)).toBe('2026-04-21T00:00:00.000Z')
  })

  it('preserves a newer installed manifest when cached manifest is older', async () => {
    await writeInstalledManifest(root, '2026-04-23T00:00:00.000Z')
    const limactlPath = await fakeLimactl(
      {
        list: {
          stdout: JSON.stringify([
            { name: VM_NAME, status: 'Running', dir: limaHome },
          ]),
        },
      },
      logPath,
    )
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      templatePath,
      browserosRoot: root,
    })
    socketServer = await createSocket(getContainerdSocketPath(root))

    await runtime.ensureReady()

    expect(await readInstalledUpdatedAt(root)).toBe('2026-04-23T00:00:00.000Z')
  })

  it('does not auto-reset when socket readiness fails', async () => {
    const limactlPath = await fakeLimactl(
      { list: { stdout: '' }, create: {}, start: {} },
      logPath,
    )
    const runtime = new VmRuntime({
      limactlPath,
      limaHome,
      templatePath,
      browserosRoot: root,
      socketTimeoutMs: 10,
      socketPollMs: 1,
    })
    let resetCalled = false
    runtime.reset = async () => {
      resetCalled = true
      throw new Error('reset called')
    }

    await expect(runtime.ensureReady()).rejects.toThrow(VmNotReadyError)
    expect(resetCalled).toBe(false)
  })

  it('delegates runCommand through ssh', async () => {
    const sshPath = await fakeSsh({}, logPath)
    const sshConfig = join(limaHome, VM_NAME, 'ssh.config')
    await mkdir(join(limaHome, VM_NAME), { recursive: true })
    await writeFile(sshConfig, '')
    const runtime = new VmRuntime({
      limactlPath: 'unused',
      limaHome,
      sshPath,
      browserosRoot: root,
    })

    await expect(runtime.runCommand(['nerdctl', 'version'])).resolves.toBe(0)

    const log = await readFile(logPath, 'utf8')
    expect(log).toContain(
      `ARGS:-F ${sshConfig} lima-${VM_NAME} 'nerdctl' 'version'`,
    )
  })

  it('resolves and caches the VM default gateway through ssh', async () => {
    const sshPath = await fakeSsh(
      {
        stdout:
          'default via 192.168.5.2 dev eth0 proto dhcp src 192.168.5.15 metric 100\n',
      },
      logPath,
    )
    const sshConfig = join(limaHome, VM_NAME, 'ssh.config')
    await mkdir(join(limaHome, VM_NAME), { recursive: true })
    await writeFile(sshConfig, '')
    const runtime = new VmRuntime({
      limactlPath: 'unused',
      limaHome,
      sshPath,
      browserosRoot: root,
    })

    await expect(runtime.getDefaultGateway()).resolves.toBe('192.168.5.2')
    await expect(runtime.getDefaultGateway()).resolves.toBe('192.168.5.2')

    const log = await readFile(logPath, 'utf8')
    expect(log.match(/'ip' '-4' 'route' 'show' 'default'/g)).toHaveLength(1)
  })
})

async function writeCachedManifest(root: string): Promise<void> {
  const manifestPath = getCachedManifestPath(root)
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
}

async function writeInstalledManifest(
  root: string,
  updatedAt = manifest.updatedAt,
): Promise<void> {
  const manifestPath = getInstalledManifestPath(root)
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, updatedAt })}\n`,
  )
}

async function readInstalledUpdatedAt(root: string): Promise<string> {
  const raw = await readFile(getInstalledManifestPath(root), 'utf8')
  return (JSON.parse(raw) as VmManifest).updatedAt
}

async function createSocket(
  path: string,
): Promise<ReturnType<typeof Bun.listen>> {
  await mkdir(dirname(path), { recursive: true })
  return Bun.listen({
    unix: path,
    socket: {
      data() {},
    },
  })
}
