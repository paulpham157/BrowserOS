/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, initializeDb } from '../../../src/lib/db'
import { agentDefinitions } from '../../../src/lib/db/schema'

describe('database initialization', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    closeDb()
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    )
    tempDirs.length = 0
  })

  it('creates the parent directory, opens sqlite, and runs migrations', () => {
    const dir = mkTempDir()
    const dbPath = join(dir, 'nested', 'browseros.sqlite')

    const handle = initializeDb({ dbPath })
    const rows = handle.db.select().from(agentDefinitions).all()

    expect(existsSync(dbPath)).toBe(true)
    expect(rows).toEqual([])
  })

  it('is idempotent when initialized twice for the same path', () => {
    const dir = mkTempDir()
    const dbPath = join(dir, 'browseros.sqlite')

    const first = initializeDb({ dbPath })
    const second = initializeDb({ dbPath })

    expect(second).toBe(first)
  })

  it('bootstraps the current schema when migration files are unavailable', () => {
    const dir = mkTempDir()
    const handle = initializeDb({
      dbPath: join(dir, 'browseros.sqlite'),
      migrationsDir: join(dir, 'missing-migrations'),
    })

    expectCurrentSchema(handle)
    expect(handle.db.select().from(agentDefinitions).all()).toEqual([])
  })

  it('bootstraps the current schema when a migration directory is empty', () => {
    const dir = mkTempDir()
    const migrationsDir = join(dir, 'empty-migrations')
    mkdirSync(migrationsDir)

    const handle = initializeDb({
      dbPath: join(dir, 'browseros.sqlite'),
      migrationsDir,
    })

    expect(handle.migrationsDir).toBe(null)
    expectCurrentSchema(handle)
    expect(handle.db.select().from(agentDefinitions).all()).toEqual([])
  })

  it('skips empty packaged migration resources', () => {
    const dir = mkTempDir()
    const resourcesDir = join(dir, 'resources')
    const packagedMigrationsDir = join(resourcesDir, 'db', 'migrations')
    mkdirSync(packagedMigrationsDir, { recursive: true })

    const handle = initializeDb({
      dbPath: join(dir, 'browseros.sqlite'),
      resourcesDir,
    })

    expect(handle.migrationsDir).not.toBe(packagedMigrationsDir)
    expect(handle.db.select().from(agentDefinitions).all()).toEqual([])
  })

  it('does not rerun old migrations after fallback schema bootstrap', () => {
    const dir = mkTempDir()
    const dbPath = join(dir, 'browseros.sqlite')

    initializeDb({
      dbPath,
      migrationsDir: join(dir, 'missing-migrations'),
    })
    closeDb()

    expect(() => initializeDb({ dbPath })).not.toThrow()
  })

  function expectCurrentSchema(handle: ReturnType<typeof initializeDb>): void {
    const tables = handle.sqlite
      .query<{ name: string }, []>(
        `
          SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'agent_definitions',
              'oauth_tokens',
              'produced_files',
              '__drizzle_migrations'
            )
          ORDER BY name
        `,
      )
      .all()
      .map((row) => row.name)

    expect(tables).toEqual([
      '__drizzle_migrations',
      'agent_definitions',
      'oauth_tokens',
      'produced_files',
    ])
    const migrations = handle.sqlite
      .query<{ hash: string; createdAt: number }, []>(
        `
          SELECT hash, created_at AS createdAt
          FROM __drizzle_migrations
          ORDER BY created_at
        `,
      )
      .all()

    expect(migrations).toEqual(expectedMigrationHistory)
  }

  function mkTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'browseros-db-test-'))
    tempDirs.push(dir)
    return dir
  }
})

const expectedMigrationHistory = [
  {
    hash: 'aadfc2e86410febb11a974d25d99d5f7196aa797d9635ced9a18cd4eeb503b61',
    createdAt: 1777750582590,
  },
  {
    hash: '19e693f7b1adcd1d932fa6cf5638b5b158c66ea5de4f154bc59311f4d6f71261',
    createdAt: 1777752799806,
  },
  {
    hash: '02b11bf1dc34a5a289efd216233a48f0b7b950cfc33eaa7ebe6dcbb15d07f75c',
    createdAt: 1777902205667,
  },
]
