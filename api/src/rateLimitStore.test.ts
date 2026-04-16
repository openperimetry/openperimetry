import { describe, expect, it, vi } from 'vitest'
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

describe('allowRequestPersistent (sqlite)', () => {
  it('allows up to limit per window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-10T10:00:00Z'))

    process.env.DATA_BACKEND = 'sqlite'
    process.env.SQLITE_DB_PATH = `/tmp/op-rate-limit-test-${crypto.randomUUID()}.sqlite`
    rmSqliteArtifacts(process.env.SQLITE_DB_PATH)

    vi.resetModules()
    const { allowRequestPersistent } = await import('./rateLimitStore.js')

    expect(await allowRequestPersistent('user:1', 2, 1000)).toBe(true)
    expect(await allowRequestPersistent('user:1', 2, 1000)).toBe(true)
    expect(await allowRequestPersistent('user:1', 2, 1000)).toBe(false)
  })

  it('resets after window rolls over', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-10T10:00:00Z'))

    process.env.DATA_BACKEND = 'sqlite'
    process.env.SQLITE_DB_PATH = `/tmp/op-rate-limit-test-${crypto.randomUUID()}.sqlite`
    rmSqliteArtifacts(process.env.SQLITE_DB_PATH)

    vi.resetModules()
    const { allowRequestPersistent } = await import('./rateLimitStore.js')

    expect(await allowRequestPersistent('user:2', 1, 1000)).toBe(true)
    expect(await allowRequestPersistent('user:2', 1, 1000)).toBe(false)

    vi.setSystemTime(new Date('2026-02-10T10:00:02Z'))
    expect(await allowRequestPersistent('user:2', 1, 1000)).toBe(true)
  })
})
