import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'

function rmSqliteArtifacts(filePath: string) {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.rmSync(`${filePath}${suffix}`)
    } catch {
      // ignore
    }
  }
}

describe('getAdminStats.totalTestsCompleted (sqlite)', () => {
  it('counts all test_completed events, ignoring other event types', async () => {
    process.env.DATA_BACKEND = 'sqlite'
    process.env.SQLITE_DB_PATH = `/tmp/op-admin-counter-test-${crypto.randomUUID()}.sqlite`
    rmSqliteArtifacts(process.env.SQLITE_DB_PATH)

    const { vi } = await import('vitest')
    vi.resetModules()
    const store = await import('./sqliteStore.js')

    await store.trackEvent('dev-1', 'test_completed')
    await store.trackEvent('dev-2', 'test_completed')
    await store.trackEvent('dev-3', 'test_completed')
    await store.trackEvent('dev-1', 'test_started')
    await store.trackEvent('dev-1', 'pdf_exported')

    const stats = await store.getAdminStats()
    expect(stats.totalTestsCompleted).toBe(3)
  })

  it('is 0 when no tests have completed', async () => {
    process.env.DATA_BACKEND = 'sqlite'
    process.env.SQLITE_DB_PATH = `/tmp/op-admin-counter-empty-${crypto.randomUUID()}.sqlite`
    rmSqliteArtifacts(process.env.SQLITE_DB_PATH)

    const { vi } = await import('vitest')
    vi.resetModules()
    const store = await import('./sqliteStore.js')

    await store.trackEvent('dev-1', 'page_view')
    const stats = await store.getAdminStats()
    expect(stats.totalTestsCompleted).toBe(0)
  })
})
