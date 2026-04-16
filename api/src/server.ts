import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import { z } from 'zod'

import {
  type AuthUser,
  deleteUserAccount,
  findUserByToken,
  loginUser,
  registerUser,
  revokeToken,
  updateUserEmail,
  updateUserPassword,
  requestPasswordReset,
  resetPasswordWithToken,
  addVFResult,
  listVFResults,
  deleteVFResult,
  addVFSurvey,
  getAdminStats,
  listAllSessions,
  listAllVFResults,
  listAllSurveys,
  trackEvent,
  listAllEvents,
} from './authStore.js'
import {
  PORT,
  FRONTEND_ORIGIN,
  FRONTEND_PUBLIC_URL,
  TRUST_PROXY_HOPS,
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_SECURE,
  AUTH_COOKIE_MAX_AGE_MS,
  RATE_LIMIT_REGISTER,
  RATE_LIMIT_LOGIN,
  RATE_LIMIT_CONTACT,
  RATE_LIMIT_WINDOW_MS,
  IS_PRODUCTION,
} from './config.js'
import { sendContactMessage, sendEmailChangedNotice, sendPasswordChangedNotice, sendPasswordResetInvite, sendWelcomeEmail } from './email.js'
import { allowRequestPersistent } from './rateLimitStore.js'

const app = express()
const allowedFrontendOrigins = FRONTEND_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

type AuthenticatedRequest = express.Request & { authUser: AuthUser; authToken: string }

type RateLimitScope = 'register' | 'login' | 'contact'

async function allowRateLimited(
  key: string,
  scope: RateLimitScope,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const composite = `${scope}:${key}`
  try {
    return await allowRequestPersistent(composite, limit, windowMs)
  } catch (error) {
    console.error('Persistent rate limit error', error)
    return false
  }
}

function getClientIp(req: express.Request): string {
  return req.ip || 'unknown'
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true)
        return
      }
      if (allowedFrontendOrigins.includes(origin)) {
        callback(null, true)
        return
      }
      // Dev convenience: allow local origins (helps when switching between localhost and 127.0.0.1).
      if (
        !IS_PRODUCTION &&
        (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))
      ) {
        callback(null, true)
        return
      }
      callback(null, false)
    },
    credentials: true,
  }),
)
app.set('trust proxy', TRUST_PROXY_HOPS)
app.use(cookieParser())
app.use(express.json({ limit: '5mb' }))

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null
  }
  const [scheme, token] = authHeader.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null
  }
  return token
}

function setAuthCookie(res: express.Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: AUTH_COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  })
}

function clearAuthCookie(res: express.Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: AUTH_COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
  })
}

function extractAuthToken(req: express.Request): string | null {
  const bearer = extractBearerToken(req.header('authorization'))
  if (bearer) {
    return bearer
  }
  const cookieToken = (req.cookies?.[AUTH_COOKIE_NAME] as string | undefined)?.trim()
  return cookieToken || null
}

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const token = extractAuthToken(req)
  if (!token) {
    res.status(401).json({ error: 'Not logged in.' })
    return
  }

  const user = await findUserByToken(token)
  if (!user) {
    res.status(401).json({ error: 'Session expired. Please log in again.' })
    return
  }

  const authReq = req as AuthenticatedRequest
  authReq.authUser = user
  authReq.authToken = token
  next()
}

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const authReq = req as AuthenticatedRequest
  if (!authReq.authUser?.isAdmin) {
    res.status(403).json({ error: 'Admin access required.' })
    return
  }
  next()
}

app.get('/api/health', (_req, res) => {
  // Cheap liveness check — returns as soon as Express is up.
  // The cold-start 502s that motivated a DB-readiness probe are now addressed by:
  //  (a) increased App Runner health check timeout (10s) and unhealthy threshold (5),
  //  (b) frontend retry-with-backoff on 502/503 in api.ts.
  // A DB-dependent probe would make this endpoint flaky when DynamoDB has
  // transient latency, and that flakiness is what breaks App Runner routing.
  res.json({ ok: true })
})

// ── Auth ──

const registerSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(60),
  password: z.string().min(8).max(128),
})

app.post('/api/auth/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid registration data.' })
    return
  }

  const ip = getClientIp(req)
  if (!(await allowRateLimited(ip, 'register', RATE_LIMIT_REGISTER, RATE_LIMIT_WINDOW_MS))) {
    res.status(429).json({ error: 'Too many requests, please try again later.' })
    return
  }

  const result = await registerUser(parsed.data)
  if ('error' in result) {
    res.status(409).json({ error: 'Email address already exists.' })
    return
  }

  void sendWelcomeEmail({
    to: result.user.email,
    displayName: result.user.displayName,
  }).catch((error) => {
    console.error('Welcome email send failed', error)
  })

  setAuthCookie(res, result.token)
  res.status(201).json({ user: result.user })
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
})

app.post('/api/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid login credentials.' })
    return
  }

  const ip = getClientIp(req)
  if (!(await allowRateLimited(ip, 'login', RATE_LIMIT_LOGIN, RATE_LIMIT_WINDOW_MS))) {
    res.status(429).json({ error: 'Too many login attempts, please try again later.' })
    return
  }

  const result = await loginUser(parsed.data)
  if ('error' in result) {
    res.status(401).json({ error: 'Invalid email or password.' })
    return
  }

  setAuthCookie(res, result.token)
  res.json({ user: result.user })
})

// ── Password reset ──

const passwordResetRequestSchema = z.object({
  email: z.string().email(),
})

app.post('/api/auth/password-reset/request', async (req, res) => {
  const parsed = passwordResetRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(200).json({ ok: true })
    return
  }

  const ip = getClientIp(req)
  if (!(await allowRateLimited(ip, 'login', RATE_LIMIT_LOGIN, RATE_LIMIT_WINDOW_MS))) {
    res.status(200).json({ ok: true })
    return
  }

  try {
    const result = await requestPasswordReset(parsed.data.email)
    if (result) {
      const resetUrl = `${FRONTEND_PUBLIC_URL.replace(/\/+$/, '')}/?resetToken=${encodeURIComponent(result.token)}`
      void sendPasswordResetInvite({
        to: result.email,
        displayName: result.displayName,
        resetUrl,
      }).catch((error) => {
        console.error('Password reset email send failed', error)
      })
    }
  } catch (error) {
    console.error('Password reset request failed', error)
  }

  res.status(200).json({ ok: true })
})

const passwordResetConfirmSchema = z.object({
  token: z.string().min(20).max(300),
  newPassword: z.string().min(8).max(128),
})

app.post('/api/auth/password-reset/confirm', async (req, res) => {
  const parsed = passwordResetConfirmSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid reset data.' })
    return
  }

  const result = await resetPasswordWithToken({
    token: parsed.data.token,
    newPassword: parsed.data.newPassword,
  })
  if ('error' in result) {
    res.status(400).json({ error: 'Reset link is invalid or expired.' })
    return
  }

  void sendPasswordChangedNotice({
    to: result.email,
    displayName: result.displayName,
  }).catch((error) => {
    console.error('Password changed notice send failed', error)
  })

  res.status(200).json({ ok: true })
})

app.get('/api/auth/me', requireAuth, (req, res) => {
  const authReq = req as AuthenticatedRequest
  res.json({ user: authReq.authUser })
})

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const authReq = req as AuthenticatedRequest
  await revokeToken(authReq.authToken)
  clearAuthCookie(res)
  res.status(204).send()
})

app.delete('/api/users/me', requireAuth, async (req, res) => {
  const authReq = req as AuthenticatedRequest
  await deleteUserAccount(authReq.authUser.id)
  clearAuthCookie(res)
  res.status(204).send()
})

// ── Account updates ──

const updateEmailSchema = z.object({
  newEmail: z.string().email(),
  currentPassword: z.string().min(8).max(128),
})

app.patch('/api/users/me/email', requireAuth, async (req, res) => {
  const parsed = updateEmailSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid email update request.' })
    return
  }
  const authReq = req as AuthenticatedRequest
  const result = await updateUserEmail({
    userId: authReq.authUser.id,
    currentPassword: parsed.data.currentPassword,
    newEmail: parsed.data.newEmail,
  })
  if ('error' in result) {
    if (result.error === 'invalid_credentials') {
      res.status(401).json({ error: 'Current password is incorrect.' })
      return
    }
    if (result.error === 'email_exists') {
      res.status(409).json({ error: 'This email address is already in use.' })
      return
    }
    res.status(404).json({ error: 'Account not found.' })
    return
  }

  void sendEmailChangedNotice({
    to: result.user.email,
    displayName: result.user.displayName,
    newEmail: result.user.email,
  }).catch((error) => {
    console.error('Email changed notice failed', error)
  })

  clearAuthCookie(res)
  res.json({ user: result.user, reauthRequired: true })
})

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128),
})

app.patch('/api/users/me/password', requireAuth, async (req, res) => {
  const parsed = updatePasswordSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid password update request.' })
    return
  }
  const authReq = req as AuthenticatedRequest
  const result = await updateUserPassword({
    userId: authReq.authUser.id,
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.newPassword,
  })
  if ('error' in result) {
    if (result.error === 'invalid_credentials') {
      res.status(401).json({ error: 'Current password is incorrect.' })
      return
    }
    res.status(404).json({ error: 'Account not found.' })
    return
  }

  void sendPasswordChangedNotice({
    to: authReq.authUser.email,
    displayName: authReq.authUser.displayName,
  }).catch((error) => {
    console.error('Password changed notice failed', error)
  })

  clearAuthCookie(res)
  res.status(200).json({ reauthRequired: true })
})

// ── Visual Field Test Results ──

app.get('/api/users/me/vf-results', requireAuth, async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const results = await listVFResults(authReq.authUser.id)
  res.json({ results })
})

const vfResultSchema = z.object({
  id: z.string().min(1),
  eye: z.enum(['left', 'right', 'both']),
  date: z.string().min(4),
  data: z.string().min(10).max(2_000_000), // full Goldmann results can be large
})

app.post('/api/users/me/vf-results', requireAuth, async (req, res) => {
  const parsed = vfResultSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid visual field result data.' })
    return
  }
  const authReq = req as AuthenticatedRequest
  const saved = await addVFResult(authReq.authUser.id, parsed.data)
  res.status(201).json({ result: saved })
})

app.post('/api/users/me/vf-results/sync', requireAuth, async (req, res) => {
  const arraySchema = z.array(vfResultSchema).max(50)
  const parsed = arraySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid sync data.' })
    return
  }
  const authReq = req as AuthenticatedRequest
  const existing = await listVFResults(authReq.authUser.id)
  const existingIds = new Set(existing.map(r => r.id))
  let added = 0
  for (const result of parsed.data) {
    if (!existingIds.has(result.id)) {
      await addVFResult(authReq.authUser.id, result)
      added++
    }
  }
  const allResults = await listVFResults(authReq.authUser.id)
  res.json({ results: allResults, added })
})

app.delete('/api/users/me/vf-results/:id', requireAuth, async (req, res) => {
  const authReq = req as AuthenticatedRequest
  await deleteVFResult(authReq.authUser.id, req.params.id)
  res.status(204).send()
})

// ── Visual Field Surveys (public, not tied to user accounts) ──

const vfSurveySchema = z.object({
  id: z.string().min(1),
  resultId: z.string().min(1),
  date: z.string().min(4),
  data: z.string().min(2).max(50_000),
  deviceId: z.string().uuid(),
})

app.post('/api/vf-surveys', async (req, res) => {
  const parsed = vfSurveySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid survey data.' })
    return
  }
  const storageKey = `device:${parsed.data.deviceId}`
  await addVFSurvey(storageKey, {
    id: parsed.data.id,
    resultId: parsed.data.resultId,
    date: parsed.data.date,
    data: parsed.data.data,
  })
  res.status(201).json({ ok: true })
})

// ── Admin ──

app.get('/api/admin/stats', requireAuth, requireAdmin, async (_req, res) => {
  const stats = await getAdminStats()
  res.json(stats)
})

app.get('/api/admin/sessions', requireAuth, requireAdmin, async (_req, res) => {
  const sessions = await listAllSessions()
  res.json({ sessions })
})

app.get('/api/admin/vf-results', requireAuth, requireAdmin, async (_req, res) => {
  const results = await listAllVFResults()
  res.json({ results })
})

app.get('/api/admin/surveys', requireAuth, requireAdmin, async (_req, res) => {
  const surveys = await listAllSurveys()
  res.json({ surveys })
})

// ── Anonymous usage events ──

const eventSchema = z.object({
  event: z.enum(['test_started', 'test_completed', 'test_aborted', 'page_view', 'pdf_exported', 'whatsapp_shared']),
  deviceId: z.string().uuid(),
  meta: z.record(z.string(), z.string()).optional(),
})

app.post('/api/events', async (req, res) => {
  const parsed = eventSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid event data.' })
    return
  }
  const meta = parsed.data.meta ? Object.fromEntries(Object.entries(parsed.data.meta).map(([k, v]) => [k, String(v)])) : undefined
  await trackEvent(parsed.data.deviceId, parsed.data.event, meta)
  res.status(201).json({ ok: true })
})

app.get('/api/admin/events', requireAuth, requireAdmin, async (_req, res) => {
  const events = await listAllEvents()
  res.json({ events })
})

// ── Contact form ──

const contactSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  message: z.string().min(1).max(5000),
})

app.post('/api/contact', async (req, res) => {
  const parsed = contactSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Please fill in all fields.' })
    return
  }

  const ip = getClientIp(req)
  if (!(await allowRateLimited(ip, 'contact', RATE_LIMIT_CONTACT, RATE_LIMIT_WINDOW_MS))) {
    res.status(429).json({ error: 'Too many messages. Please try again later.' })
    return
  }

  try {
    await sendContactMessage(parsed.data)
    res.json({ ok: true })
  } catch (error) {
    console.error('Contact form send failed', error)
    res.status(500).json({ error: 'Failed to send message. Please try again.' })
  }
})

// Bind explicitly to 0.0.0.0 (IPv4) — App Runner's envoy proxy uses IPv4 and
// Node's default IPv6-first binding can cause "Failed to route traffic" errors.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenPerimetry API running on http://0.0.0.0:${PORT}`)
})
