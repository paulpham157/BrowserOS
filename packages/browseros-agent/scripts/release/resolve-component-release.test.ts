import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')
const resolver = join(repoRoot, 'scripts/release/resolve-component-release.sh')
const serverReleaseResolver = join(
  repoRoot,
  'scripts/release/resolve-server-release.sh',
)
const bumpServerVersion = join(
  repoRoot,
  '../browseros/build/scripts/bump_server_version.py',
)

type Component = 'agent-extension' | 'agent-server'

function packagePath(component: Component): string {
  return component === 'agent-extension'
    ? 'apps/app/package.json'
    : 'apps/server/package.json'
}

function scopedTag(component: Component, version: string): string {
  return component === 'agent-extension'
    ? `agent-extension/v${version}`
    : `agent-server/v${version}`
}

function legacyTag(component: Component, version: string): string {
  return component === 'agent-extension'
    ? `agent-extension-v${version}`
    : `browseros-server-v${version}`
}

async function run(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

async function mustRun(cwd: string, args: string[]): Promise<string> {
  const result = await run(cwd, args)
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

async function initFixture(
  component: Component,
  version: string,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'component-release-'))
  await mustRun(dir, ['git', 'init', '--initial-branch=main'])
  await mustRun(dir, ['git', 'config', 'user.name', 'BrowserOS Test'])
  await mustRun(dir, ['git', 'config', 'user.email', 'test@browseros.com'])
  writePackage(dir, component, version)
  await mustRun(dir, ['git', 'add', '.'])
  await mustRun(dir, ['git', 'commit', '-m', `version ${version}`])
  return dir
}

function writePackage(
  dir: string,
  component: Component,
  version: string,
): void {
  const path = join(dir, packagePath(component))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        name:
          component === 'agent-extension'
            ? '@browseros/app'
            : '@browseros/server',
        version,
      },
      null,
      2,
    ),
  )
}

function writeNestedPackage(
  dir: string,
  component: Component,
  version: string,
): string {
  const packageDir = join(dir, 'packages/browseros-agent')
  const path = join(packageDir, packagePath(component))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        name:
          component === 'agent-extension'
            ? '@browseros/app'
            : '@browseros/server',
        version,
      },
      null,
      2,
    ),
  )
  return packageDir
}

function writeServerLock(dir: string, version: string): void {
  writeFileSync(
    join(dir, 'bun.lock'),
    JSON.stringify(
      {
        lockfileVersion: 1,
        workspaces: {
          'apps/server': {
            name: '@browseros/server',
            version,
          },
        },
      },
      null,
      2,
    ),
  )
}

async function commitVersion(
  dir: string,
  component: Component,
  version: string,
): Promise<void> {
  writePackage(dir, component, version)
  await mustRun(dir, ['git', 'add', packagePath(component)])
  await mustRun(dir, ['git', 'commit', '-m', `version ${version}`])
}

async function tag(dir: string, name: string): Promise<void> {
  await mustRun(dir, ['git', 'tag', '-a', name, '-m', name])
}

async function lightweightTag(dir: string, name: string): Promise<void> {
  await mustRun(dir, ['git', 'tag', name])
}

async function resolveRelease(
  dir: string,
  component: Component,
  name: string,
  extraArgs: string[] = [],
) {
  return run(dir, [
    resolver,
    '--component',
    component,
    '--tag',
    name,
    '--default-branch',
    'main',
    ...extraArgs,
  ])
}

async function prepareServerTagRelease(dir: string, name: string) {
  return run(dir, [
    serverReleaseResolver,
    '--event-name',
    'push',
    '--release-tag',
    name,
    '--default-branch',
    'main',
    '--apply-bump',
    'false',
    '--publish-github-release',
    'true',
    '--agent-root',
    dir,
    '--bump-script',
    bumpServerVersion,
  ])
}

async function resolveServerRelease(
  dir: string,
  options: {
    eventName?: string
    requestedVersion?: string
    releaseTag?: string
    applyBump?: boolean
    publishGithubRelease?: boolean
  } = {},
) {
  const args = [
    serverReleaseResolver,
    '--event-name',
    options.eventName ?? 'workflow_dispatch',
    '--default-branch',
    'main',
    '--apply-bump',
    options.applyBump ? 'true' : 'false',
    '--publish-github-release',
    options.publishGithubRelease === false ? 'false' : 'true',
    '--agent-root',
    dir,
    '--bump-script',
    bumpServerVersion,
  ]

  if (options.requestedVersion !== undefined) {
    args.push('--requested-version', options.requestedVersion)
  }
  if (options.releaseTag !== undefined) {
    args.push('--release-tag', options.releaseTag)
  }

  return run(dir, args)
}

async function initServerReleaseFixture(version: string) {
  const dir = await initFixture('agent-server', version)
  const bareDir = mkdtempSync(join(tmpdir(), 'component-release-remote-'))
  writeServerLock(dir, version)
  await mustRun(dir, ['git', 'add', 'bun.lock'])
  await mustRun(dir, ['git', 'commit', '-m', 'add server lock'])
  await mustRun(bareDir, ['git', 'init', '--bare'])
  await mustRun(dir, ['git', 'remote', 'add', 'origin', bareDir])
  await mustRun(dir, ['git', 'push', '-u', 'origin', 'main'])
  return { dir, bareDir }
}

function parseOutput(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  )
}

describe('resolve-component-release', () => {
  it('rejects non-strict slash tags', async () => {
    const dir = await initFixture('agent-extension', '0.0.100')
    try {
      for (const invalidTag of [
        'agent-extension/0.0.100',
        'agent-extension/v0.0',
        'agent-extension/v01.0.0',
        'agent-extension/v0.0.100-rc1',
        'agent-extension-v0.0.100',
      ]) {
        const result = await resolveRelease(dir, 'agent-extension', invalidTag)

        expect(result.code, invalidTag).toBe(1)
        expect(result.stderr).toContain(
          'Expected agent-extension tag like agent-extension/vX.Y.Z',
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves an extension slash tag and previous tag across tag schemes', async () => {
    const dir = await initFixture('agent-extension', '0.0.98')
    try {
      await tag(dir, legacyTag('agent-extension', '0.0.98'))
      await commitVersion(dir, 'agent-extension', '0.0.99')
      await tag(dir, scopedTag('agent-extension', '0.0.99'))
      await commitVersion(dir, 'agent-extension', '0.0.100')
      const currentTag = scopedTag('agent-extension', '0.0.100')
      await tag(dir, currentTag)

      const result = await resolveRelease(dir, 'agent-extension', currentTag)

      expect(result.code, result.stderr).toBe(0)
      expect(parseOutput(result.stdout)).toMatchObject({
        version: '0.0.100',
        package_version: '0.0.100',
        tag: currentTag,
        previous_tag: scopedTag('agent-extension', '0.0.99'),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a server slash tag against legacy browseros-server tags', async () => {
    const dir = await initFixture('agent-server', '0.0.121')
    try {
      await tag(dir, legacyTag('agent-server', '0.0.121'))
      await commitVersion(dir, 'agent-server', '0.0.122')
      const currentTag = scopedTag('agent-server', '0.0.122')
      await tag(dir, currentTag)

      const result = await resolveRelease(dir, 'agent-server', currentTag)

      expect(result.code, result.stderr).toBe(0)
      expect(parseOutput(result.stdout)).toMatchObject({
        version: '0.0.122',
        previous_tag: legacyTag('agent-server', '0.0.121'),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a server slash tag from a nested browseros-agent checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'component-release-nested-'))
    try {
      await mustRun(dir, ['git', 'init', '--initial-branch=main'])
      await mustRun(dir, ['git', 'config', 'user.name', 'BrowserOS Test'])
      await mustRun(dir, ['git', 'config', 'user.email', 'test@browseros.com'])
      const packageDir = writeNestedPackage(dir, 'agent-server', '0.0.122')
      await mustRun(dir, ['git', 'add', '.'])
      await mustRun(dir, ['git', 'commit', '-m', 'version 0.0.122'])
      const currentTag = scopedTag('agent-server', '0.0.122')
      await tag(dir, currentTag)
      const releaseSha = (
        await mustRun(dir, ['git', 'rev-parse', 'HEAD'])
      ).trim()

      const result = await resolveRelease(
        packageDir,
        'agent-server',
        currentTag,
      )

      expect(result.code, result.stderr).toBe(0)
      expect(parseOutput(result.stdout)).toMatchObject({
        package_version: '0.0.122',
        tag: currentTag,
        release_sha: releaseSha,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects lightweight component release tags', async () => {
    const dir = await initFixture('agent-server', '0.0.122')
    try {
      const currentTag = scopedTag('agent-server', '0.0.122')
      await lightweightTag(dir, currentTag)

      const result = await resolveRelease(dir, 'agent-server', currentTag)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        'Tag agent-server/v0.0.122 must be an annotated tag',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a tag version that does not match the package version', async () => {
    const dir = await initFixture('agent-extension', '0.0.99')
    try {
      const currentTag = scopedTag('agent-extension', '0.0.100')
      await tag(dir, currentTag)

      const result = await resolveRelease(dir, 'agent-extension', currentTag)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        'Tag version 0.0.100 does not match apps/app/package.json version 0.0.99',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('can preflight a package version mismatch for repair', async () => {
    const dir = await initFixture('agent-extension', '0.0.99')
    try {
      const currentTag = scopedTag('agent-extension', '0.0.100')
      await tag(dir, currentTag)

      const result = await resolveRelease(dir, 'agent-extension', currentTag, [
        '--allow-package-version-mismatch',
      ])

      expect(result.code, result.stderr).toBe(0)
      expect(parseOutput(result.stdout)).toMatchObject({
        version: '0.0.100',
        package_version: '0.0.99',
        package_version_matches: 'false',
        tag: currentTag,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates the package version from the tagged commit instead of the current checkout', async () => {
    const dir = await initFixture('agent-extension', '0.0.99')
    try {
      const currentTag = scopedTag('agent-extension', '0.0.100')
      await tag(dir, currentTag)
      await commitVersion(dir, 'agent-extension', '0.0.100')

      const result = await resolveRelease(dir, 'agent-extension', currentTag)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        'Tag version 0.0.100 does not match apps/app/package.json version 0.0.99',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a duplicate version from either tag scheme', async () => {
    const dir = await initFixture('agent-extension', '0.0.100')
    try {
      await tag(dir, legacyTag('agent-extension', '0.0.100'))
      const currentTag = scopedTag('agent-extension', '0.0.100')
      await tag(dir, currentTag)

      const result = await resolveRelease(dir, 'agent-extension', currentTag)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        'Release version 0.0.100 already exists as tag agent-extension-v0.0.100',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-incrementing release tag', async () => {
    const dir = await initFixture('agent-server', '0.0.101')
    try {
      await tag(dir, legacyTag('agent-server', '0.0.101'))
      await commitVersion(dir, 'agent-server', '0.0.100')
      const currentTag = scopedTag('agent-server', '0.0.100')
      await tag(dir, currentTag)

      const result = await resolveRelease(dir, 'agent-server', currentTag)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        'Release version 0.0.100 must be greater than latest existing agent-server version 0.0.101',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a tagged commit that is not reachable from the default branch', async () => {
    const dir = await initFixture('agent-extension', '0.0.99')
    try {
      await mustRun(dir, ['git', 'checkout', '-b', 'release-side'])
      await commitVersion(dir, 'agent-extension', '0.0.100')
      const currentTag = scopedTag('agent-extension', '0.0.100')
      await tag(dir, currentTag)

      const result = await resolveRelease(dir, 'agent-extension', currentTag)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('is not reachable from main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fetches the default branch ref for tag-only checkouts', async () => {
    const sourceDir = await initFixture('agent-server', '0.0.122')
    const bareDir = mkdtempSync(join(tmpdir(), 'component-release-origin-'))
    const checkoutDir = mkdtempSync(
      join(tmpdir(), 'component-release-checkout-'),
    )
    try {
      const currentTag = scopedTag('agent-server', '0.0.122')
      await tag(sourceDir, currentTag)
      await mustRun(sourceDir, ['git', 'clone', '--bare', sourceDir, bareDir])
      await mustRun(checkoutDir, ['git', 'init'])
      await mustRun(checkoutDir, ['git', 'remote', 'add', 'origin', bareDir])
      await mustRun(checkoutDir, ['git', 'fetch', 'origin', 'tag', currentTag])
      await mustRun(checkoutDir, ['git', 'checkout', currentTag])

      const result = await resolveRelease(
        checkoutDir,
        'agent-server',
        currentTag,
      )

      expect(result.code, result.stderr).toBe(0)
      expect(parseOutput(result.stdout)).toMatchObject({
        version: '0.0.122',
        tag: currentTag,
      })
    } finally {
      rmSync(sourceDir, { recursive: true, force: true })
      rmSync(bareDir, { recursive: true, force: true })
      rmSync(checkoutDir, { recursive: true, force: true })
    }
  })

  it('commits a manual server version when input is newer than package.json', async () => {
    const { dir, bareDir } = await initServerReleaseFixture('0.0.122')
    try {
      const oldSha = (await mustRun(dir, ['git', 'rev-parse', 'HEAD'])).trim()

      const result = await resolveServerRelease(dir, {
        requestedVersion: '0.0.123',
      })

      expect(result.code, result.stderr).toBe(0)
      const output = parseOutput(result.stdout)
      expect(output).toMatchObject({
        package_version: '0.0.123',
        tag: scopedTag('agent-server', '0.0.123'),
        previous_tag: '',
      })
      expect(output.release_sha).not.toBe(oldSha)
      expect(
        (await mustRun(dir, ['git', 'rev-parse', 'origin/main'])).trim(),
      ).toBe(output.release_sha)
      expect(
        (
          await mustRun(dir, [
            'git',
            'rev-list',
            '-n',
            '1',
            scopedTag('agent-server', '0.0.123'),
          ])
        ).trim(),
      ).toBe(output.release_sha)
      expect(
        (
          await mustRun(dir, [
            'git',
            'cat-file',
            '-t',
            `refs/tags/${scopedTag('agent-server', '0.0.123')}`,
          ])
        ).trim(),
      ).toBe('tag')
      expect(
        (
          await mustRun(dir, [
            'git',
            'show',
            `${output.release_sha}:apps/server/package.json`,
          ])
        ).trim(),
      ).toContain('"version": "0.0.123"')
      expect(
        (
          await mustRun(dir, ['git', 'show', `${output.release_sha}:bun.lock`])
        ).trim(),
      ).toContain('"version": "0.0.123"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bareDir, { recursive: true, force: true })
    }
  })

  it('commits and retags a pushed server tag when the tag version is newer', async () => {
    const { dir, bareDir } = await initServerReleaseFixture('0.0.122')
    try {
      const oldSha = (await mustRun(dir, ['git', 'rev-parse', 'HEAD'])).trim()
      const currentTag = scopedTag('agent-server', '0.0.123')
      await tag(dir, currentTag)
      await mustRun(dir, ['git', 'push', 'origin', currentTag])

      const result = await prepareServerTagRelease(dir, currentTag)

      expect(result.code, result.stderr).toBe(0)
      const output = parseOutput(result.stdout)
      expect(output).toMatchObject({
        package_version: '0.0.123',
        tag: currentTag,
      })
      expect(output.release_sha).not.toBe(oldSha)
      expect(
        (await mustRun(dir, ['git', 'rev-parse', 'origin/main'])).trim(),
      ).toBe(output.release_sha)
      expect(
        (await mustRun(dir, ['git', 'rev-list', '-n', '1', currentTag])).trim(),
      ).toBe(output.release_sha)
      expect(
        (
          await mustRun(dir, [
            'git',
            'show',
            `${output.release_sha}:apps/server/package.json`,
          ])
        ).trim(),
      ).toContain('"version": "0.0.123"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bareDir, { recursive: true, force: true })
    }
  })

  it('tags the current default branch without a version commit when input equals package.json', async () => {
    const { dir, bareDir } = await initServerReleaseFixture('0.0.123')
    try {
      const oldSha = (await mustRun(dir, ['git', 'rev-parse', 'HEAD'])).trim()
      const result = await resolveServerRelease(dir, {
        requestedVersion: '0.0.123',
      })

      expect(result.code, result.stderr).toBe(0)
      const output = parseOutput(result.stdout)
      expect(output).toMatchObject({
        package_version: '0.0.123',
        tag: scopedTag('agent-server', '0.0.123'),
        release_sha: oldSha,
      })
      expect(
        (await mustRun(dir, ['git', 'rev-parse', 'origin/main'])).trim(),
      ).toBe(oldSha)
      expect(
        (
          await mustRun(dir, [
            'git',
            'rev-list',
            '-n',
            '1',
            scopedTag('agent-server', '0.0.123'),
          ])
        ).trim(),
      ).toBe(oldSha)
      expect(
        (await mustRun(dir, ['git', 'rev-list', '--count', 'HEAD'])).trim(),
      ).toBe('2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bareDir, { recursive: true, force: true })
    }
  })

  it('reuses an existing server tag when its package version already matches', async () => {
    const { dir, bareDir } = await initServerReleaseFixture('0.0.123')
    try {
      const releaseSha = (
        await mustRun(dir, ['git', 'rev-parse', 'HEAD'])
      ).trim()
      const currentTag = scopedTag('agent-server', '0.0.123')
      await tag(dir, currentTag)
      await mustRun(dir, ['git', 'push', 'origin', currentTag])
      writeFileSync(join(dir, 'README.md'), 'advance main\n')
      await mustRun(dir, ['git', 'add', 'README.md'])
      await mustRun(dir, ['git', 'commit', '-m', 'advance main'])
      await mustRun(dir, ['git', 'push', 'origin', 'main'])
      const defaultSha = (
        await mustRun(dir, ['git', 'rev-parse', 'HEAD'])
      ).trim()

      const result = await resolveServerRelease(dir, {
        requestedVersion: '0.0.123',
      })

      expect(result.code, result.stderr).toBe(0)
      const output = parseOutput(result.stdout)
      expect(output).toMatchObject({
        package_version: '0.0.123',
        tag: currentTag,
        release_sha: releaseSha,
      })
      expect(
        (await mustRun(dir, ['git', 'rev-parse', 'origin/main'])).trim(),
      ).toBe(defaultSha)
      expect(
        (await mustRun(dir, ['git', 'rev-list', '-n', '1', currentTag])).trim(),
      ).toBe(releaseSha)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bareDir, { recursive: true, force: true })
    }
  })

  it('refuses a manual server release that would downgrade package.json', async () => {
    const { dir, bareDir } = await initServerReleaseFixture('0.0.124')
    try {
      const oldSha = (await mustRun(dir, ['git', 'rev-parse', 'HEAD'])).trim()
      const result = await resolveServerRelease(dir, {
        requestedVersion: '0.0.123',
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        'Requested server version 0.0.123 is lower than apps/server/package.json (0.0.124)',
      )
      expect(
        (await mustRun(dir, ['git', 'rev-parse', 'origin/main'])).trim(),
      ).toBe(oldSha)
      expect(
        (
          await mustRun(dir, ['git', 'show', 'HEAD:apps/server/package.json'])
        ).trim(),
      ).toContain('"version": "0.0.124"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bareDir, { recursive: true, force: true })
    }
  })

  it('keeps apply_bump local for non-publishing workflow-call builds', async () => {
    const dir = await initFixture('agent-server', '0.0.122')
    try {
      writeServerLock(dir, '0.0.122')
      await mustRun(dir, ['git', 'add', 'bun.lock'])
      await mustRun(dir, ['git', 'commit', '-m', 'add server lock'])
      const oldSha = (await mustRun(dir, ['git', 'rev-parse', 'HEAD'])).trim()

      const result = await resolveServerRelease(dir, {
        eventName: 'workflow_call',
        applyBump: true,
        publishGithubRelease: false,
      })

      expect(result.code, result.stderr).toBe(0)
      expect(parseOutput(result.stdout)).toMatchObject({
        package_version: '0.0.123',
        tag: scopedTag('agent-server', '0.0.123'),
        release_sha: oldSha,
      })
      expect(
        (await mustRun(dir, ['git', 'status', '--short']))
          .trimEnd()
          .split('\n'),
      ).toEqual([' M apps/server/package.json', ' M bun.lock'])
      expect((await mustRun(dir, ['git', 'rev-parse', 'HEAD'])).trim()).toBe(
        oldSha,
      )
      expect(
        (
          await mustRun(dir, ['git', 'show', 'HEAD:apps/server/package.json'])
        ).trim(),
      ).toContain('"version": "0.0.122"')
      expect(
        (await mustRun(dir, ['cat', 'apps/server/package.json'])).trim(),
      ).toContain('"version": "0.0.123"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
