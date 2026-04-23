/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '../logger'
import { LimaCommandError, VmError, VmNotReadyError } from './errors'
import { LimaCli } from './lima-cli'
import { renderLimaTemplate } from './lima-config'
import {
  compareVersions,
  readCachedManifest,
  readInstalledManifest,
  writeInstalledManifest,
} from './manifest'
import {
  getContainerdSocketPath,
  getImageCacheDir,
  getVmStateDir,
  VM_NAME,
} from './paths'
import { VM_TELEMETRY_EVENTS } from './telemetry'

export type LogFn = (msg: string) => void

export interface VmRuntimeDeps {
  limactlPath: string
  limaHome: string
  sshPath?: string
  templatePath?: string
  browserosRoot?: string
  socketTimeoutMs?: number
  socketPollMs?: number
}

export class VmRuntime {
  private readonly cli: LimaCli
  private readonly socketTimeoutMs: number
  private readonly socketPollMs: number
  private defaultGateway: string | null = null

  constructor(private readonly deps: VmRuntimeDeps) {
    this.cli = new LimaCli({
      limactlPath: deps.limactlPath,
      limaHome: deps.limaHome,
      sshPath: deps.sshPath,
    })
    this.socketTimeoutMs = deps.socketTimeoutMs ?? 60_000
    this.socketPollMs = deps.socketPollMs ?? 500
  }

  async ensureReady(onLog?: LogFn): Promise<void> {
    const started = Date.now()
    logger.info(VM_TELEMETRY_EVENTS.ensureReadyStart, {
      limaHome: this.deps.limaHome,
      browserosRoot: this.deps.browserosRoot,
      templatePath: this.deps.templatePath,
      limactlPath: this.deps.limactlPath,
    })

    const cached = await readCachedManifest(this.deps.browserosRoot)
    const installed = await readInstalledManifest(this.deps.browserosRoot)
    const versionComparison = compareVersions(installed, cached)
    logger.debug(VM_TELEMETRY_EVENTS.manifestCompared, {
      versionComparison,
      installedUpdatedAt: installed?.updatedAt ?? null,
      cachedUpdatedAt: cached.updatedAt,
    })

    const vms = await this.cli.list()
    const existing = vms.find((vm) => vm.name === VM_NAME)
    let shouldWriteInstalledManifest =
      !existing || versionComparison === 'fresh' || versionComparison === 'same'

    let branch = !existing
      ? 'provision-fresh'
      : existing.status !== 'Running'
        ? 'start-existing'
        : versionComparison === 'upgrade'
          ? 'running-upgrade-warn'
          : 'running-same'
    logger.info(VM_TELEMETRY_EVENTS.ensureReadyBranch, {
      branch,
      existingStatus: existing?.status ?? null,
      versionComparison,
    })

    if (!existing) {
      await this.provisionFresh(onLog)
    } else {
      if (existing.status !== 'Running') {
        onLog?.('Starting BrowserOS VM...')
        await this.cli.start(VM_NAME)
      }
      if (
        !(await this.isReady()) &&
        (await this.needsContainerdReprovision())
      ) {
        branch = 'recreate-legacy-runtime'
        shouldWriteInstalledManifest = true
        await this.recreateForContainerd(onLog)
      } else if (versionComparison === 'upgrade') {
        logger.warn(VM_TELEMETRY_EVENTS.upgradeDetected, {
          from: installed?.updatedAt ?? null,
          to: cached.updatedAt,
        })
      }
    }

    await this.waitForSocket(this.socketTimeoutMs)
    if (shouldWriteInstalledManifest) {
      await writeInstalledManifest(cached, this.deps.browserosRoot)
      logger.debug(VM_TELEMETRY_EVENTS.manifestWritten, {
        updatedAt: cached.updatedAt,
      })
    }

    logger.info(VM_TELEMETRY_EVENTS.ensureReadyOk, {
      durationMs: Date.now() - started,
      branch,
    })
  }

  async stopVm(): Promise<void> {
    try {
      await this.cli.stop(VM_NAME)
    } catch (error) {
      if (error instanceof LimaCommandError && isAlreadyStopped(error.stderr)) {
        return
      }
      throw error
    }
  }

  async runCommand(
    args: string[],
    opts?: { onOutput?: LogFn },
  ): Promise<number> {
    return this.cli.shell(VM_NAME, args, {
      onStdout: opts?.onOutput,
      onStderr: opts?.onOutput,
    })
  }

  async reset(_reason: string): Promise<never> {
    throw notImplemented('VmRuntime.reset')
  }

  async performUpgrade(): Promise<never> {
    throw notImplemented('VmRuntime.performUpgrade')
  }

  async getDefaultGateway(): Promise<string> {
    if (this.defaultGateway) return this.defaultGateway

    const lines: string[] = []
    const exitCode = await this.runCommand(
      ['ip', '-4', 'route', 'show', 'default'],
      {
        onOutput: (line) => lines.push(line),
      },
    )
    if (exitCode !== 0) {
      throw new VmNotReadyError(
        `failed to resolve VM default gateway; ip route exited ${exitCode}`,
      )
    }

    const gateway = parseDefaultGateway(lines.join('\n'))
    if (!gateway) {
      throw new VmNotReadyError('failed to resolve VM default gateway')
    }
    this.defaultGateway = gateway
    return gateway
  }

  async isReady(): Promise<boolean> {
    try {
      const info = await stat(this.socketPath())
      return info.isSocket()
    } catch {
      return false
    }
  }

  getLimactlPath(): string {
    return this.deps.limactlPath
  }

  private async provisionFresh(onLog?: LogFn): Promise<void> {
    this.defaultGateway = null
    const yaml = await this.buildLimaYaml()
    const yamlPath = join(this.deps.limaHome, `${VM_NAME}.yaml`)
    await mkdir(dirname(yamlPath), { recursive: true })
    await writeFile(yamlPath, yaml)
    logger.info(VM_TELEMETRY_EVENTS.provisionYamlWrite, {
      yamlPath,
      yamlBytes: yaml.length,
      templatePath: this.deps.templatePath,
    })

    onLog?.('Creating BrowserOS VM...')
    logger.info(VM_TELEMETRY_EVENTS.provisionCreateStart, { yamlPath })
    const createStarted = Date.now()
    await this.cli.create(VM_NAME, yamlPath)
    logger.info(VM_TELEMETRY_EVENTS.provisionCreateOk, {
      durationMs: Date.now() - createStarted,
    })

    onLog?.('Starting BrowserOS VM...')
    logger.info(VM_TELEMETRY_EVENTS.provisionStartBegin, {})
    const startStarted = Date.now()
    await this.cli.start(VM_NAME)
    logger.info(VM_TELEMETRY_EVENTS.provisionStartOk, {
      durationMs: Date.now() - startStarted,
    })
  }

  private async recreateForContainerd(onLog?: LogFn): Promise<void> {
    onLog?.('Recreating BrowserOS VM for containerd runtime...')
    try {
      await this.cli.stop(VM_NAME)
    } catch (error) {
      if (
        !(error instanceof LimaCommandError) ||
        !isAlreadyStopped(error.stderr)
      ) {
        throw error
      }
    }
    await this.cli.delete(VM_NAME)
    await this.provisionFresh(onLog)
  }

  private async needsContainerdReprovision(): Promise<boolean> {
    const lines: string[] = []
    try {
      const exitCode = await this.runCommand(
        ['sh', '-lc', 'cat /etc/browseros-vm-version 2>/dev/null || true'],
        { onOutput: (line) => lines.push(line) },
      )
      if (exitCode !== 0) return false
    } catch (error) {
      logger.warn('Failed to inspect BrowserOS VM runtime marker', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }

    return !lines.some((line) => line.trim() === 'runtime:containerd')
  }

  private async buildLimaYaml(): Promise<string> {
    if (!this.deps.templatePath) {
      throw new Error(
        'BrowserOS VM Lima template path is missing; configure VmRuntime with resourcesDir',
      )
    }

    return renderLimaTemplate(await readFile(this.deps.templatePath, 'utf8'), {
      vmStateDir: getVmStateDir(this.deps.browserosRoot),
      imageCacheDir: getImageCacheDir(this.deps.browserosRoot),
    })
  }

  private async waitForSocket(timeoutMs: number): Promise<void> {
    const started = Date.now()
    const deadline = started + timeoutMs
    const sockPath = this.socketPath()
    logger.info(VM_TELEMETRY_EVENTS.socketWaitStart, {
      sockPath,
      timeoutMs,
      pollMs: this.socketPollMs,
    })
    let pollCount = 0
    while (Date.now() < deadline) {
      pollCount += 1
      if (await this.isReady()) {
        logger.info(VM_TELEMETRY_EVENTS.socketWaitOk, {
          sockPath,
          pollCount,
          waitMs: Date.now() - started,
        })
        return
      }
      if (pollCount === 1 || pollCount % 10 === 0) {
        logger.debug(VM_TELEMETRY_EVENTS.socketWaitPoll, {
          sockPath,
          pollCount,
          elapsedMs: Date.now() - started,
        })
      }
      await Bun.sleep(this.socketPollMs)
    }
    logger.error(VM_TELEMETRY_EVENTS.socketWaitTimeout, {
      sockPath,
      timeoutMs,
      pollCount,
    })
    throw new VmNotReadyError(`containerd.sock never appeared at ${sockPath}`)
  }

  private socketPath(): string {
    return getContainerdSocketPath(this.deps.browserosRoot)
  }
}

function notImplemented(feature: string): VmError {
  return new VmError(
    `${feature} is not implemented yet - see WS4 follow-up plan`,
  )
}

function isAlreadyStopped(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return (
    lower.includes('not running') ||
    lower.includes('already stopped') ||
    lower.includes('not found')
  )
}

function parseDefaultGateway(output: string): string | null {
  return output.match(/\bdefault\s+via\s+(\d+\.\d+\.\d+\.\d+)\b/)?.[1] ?? null
}
