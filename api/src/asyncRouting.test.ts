import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import { installAsyncErrorHandling, errorHandler } from './asyncRouting.js'

let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

function startApp(): Promise<string> {
  const app = express()
  installAsyncErrorHandling(app)
  app.get('/ok', (_req, res) => { res.json({ ok: true }) })
  app.get('/async-throw', async () => { throw new Error('boom-async') })
  app.get('/sync-throw', () => { throw new Error('boom-sync') })
  app.get('/reject', () => Promise.reject(new Error('boom-reject')))
  app.use(errorHandler)
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

describe('installAsyncErrorHandling', () => {
  it('turns async throws, sync throws, and rejections into 500s — process survives', async () => {
    const base = await startApp()

    // Each failing handler returns a clean 500 instead of crashing the process.
    expect((await fetch(`${base}/async-throw`)).status).toBe(500)
    expect((await fetch(`${base}/sync-throw`)).status).toBe(500)
    expect((await fetch(`${base}/reject`)).status).toBe(500)

    // The process is still alive and serving — the whole point of the fix.
    const ok = await fetch(`${base}/ok`)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })
  })

  it('leaves normal responses untouched', async () => {
    const base = await startApp()
    const ok = await fetch(`${base}/ok`)
    expect(ok.status).toBe(200)
  })
})
