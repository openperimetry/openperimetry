// Async-safe routing for Express 4.
//
// Express 4 does NOT forward a rejected async route handler to the
// error-handling middleware. The rejection becomes an unhandled promise
// rejection, which (on Node 15+) crashes the whole process — so a single
// failing route returns 503 on EVERY endpoint, not just itself. That is
// exactly what a missing DynamoDB GSI permission did in prod: the admin
// events route threw `AccessDeniedException`, the process exited, App Runner
// restarted it, the admin page re-polled, and it crash-looped.
//
// `installAsyncErrorHandling` patches the route-registration methods once,
// before any routes are declared, so every current and future handler's sync
// throw or async rejection is funnelled to `next(err)`. Paired with
// `errorHandler` (registered after all routes), a failing handler returns a
// clean 500 for that one request and the process stays up.

import type express from 'express'

type Handler = (...args: unknown[]) => unknown

/** Wrap a route handler/middleware so a sync throw or async rejection is sent
 *  to `next(err)`. Leaves non-functions and 4-arg error handlers untouched
 *  (Express identifies error middleware by its arity, which must stay 4). */
function wrap(h: unknown): unknown {
  if (typeof h !== 'function' || (h as Handler).length >= 4) return h
  return function asyncSafe(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    try {
      const out = (h as Handler)(req, res, next)
      if (out && typeof (out as { catch?: unknown }).catch === 'function') {
        ;(out as Promise<unknown>).catch(next)
      }
      return out
    } catch (err) {
      next(err)
    }
  }
}

/** Patch `app.get/post/put/patch/delete/all/use` so every handler they
 *  register is wrapped. Call once, immediately after `express()` and before
 *  any routes/middleware are registered. */
export function installAsyncErrorHandling(app: express.Application): void {
  const appAny = app as unknown as Record<string, Handler>
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'] as const) {
    const original = appAny[method].bind(app)
    appAny[method] = (...args: unknown[]) => original(...args.map(wrap))
  }
}

/** Terminal error handler — register with `app.use(errorHandler)` AFTER all
 *  routes. Turns anything funnelled here into a clean 500 instead of letting
 *  it escalate to a process crash. */
export const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('Unhandled route error', err)
  if (res.headersSent) return
  res.status(500).json({ error: 'Internal server error.' })
}

/** Last-resort net for a rejection that escapes the routing layer entirely
 *  (e.g. a fire-and-forget promise outside a request). Log, do NOT exit — a
 *  single stray rejection must never take the whole API down; App Runner's
 *  health check restarts a genuinely wedged instance. */
export function installProcessSafetyNet(): void {
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection (process kept alive)', reason)
  })
}
