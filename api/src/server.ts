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
  listClinicalParticipants,
  upsertClinicalParticipant,
  deleteClinicalParticipant,
  listClinicScreens,
  upsertClinicScreen,
  deleteClinicScreen,
  setActiveClinicScreen,
  addVFResult,
  listVFResults,
  deleteVFResult,
  addVFSurvey,
  getAdminStats,
  listAllUsers,
  setUserClinicianRole,
  listAllSessions,
  listAllVFResults,
  getAdminVFResultDetail,
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
  DEV_AUTO_LOGIN_EMAIL,
  DEV_AUTO_LOGIN_PASSWORD,
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
app.use((req, res, next) => devAutoLoginMiddleware(req, res, next))

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

// Dev-only auto-login. When DEV_AUTO_LOGIN_EMAIL + DEV_AUTO_LOGIN_PASSWORD
// are set AND we're not in production, any request without a valid session
// cookie gets silently logged in as that user. We both set the cookie on
// the response (for subsequent requests) and inject the token into
// `req.cookies` so the first request — the one that tripped the check —
// also sees itself as authenticated. We never enable this path in
// production, regardless of env values, because it would let anyone who
// knew the email/password pair impersonate the account without the
// rate-limited login endpoint.
const devAutoLoginEnabled = !IS_PRODUCTION && DEV_AUTO_LOGIN_EMAIL && DEV_AUTO_LOGIN_PASSWORD
async function devAutoLoginMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  if (!devAutoLoginEnabled) {
    next()
    return
  }
  const existing = extractAuthToken(req)
  if (existing) {
    const user = await findUserByToken(existing)
    if (user) {
      next()
      return
    }
    // Stale cookie (seed-DB wiped while the browser kept the cookie).
    // Fall through to re-login rather than leaving the client wedged.
  }
  try {
    const result = await loginUser({
      email: DEV_AUTO_LOGIN_EMAIL,
      password: DEV_AUTO_LOGIN_PASSWORD,
    })
    if ('error' in result) {
      console.warn(
        `[dev-auto-login] login failed for ${DEV_AUTO_LOGIN_EMAIL}: ${result.error}. ` +
          `Run "npm run seed" in api/ or update DEV_AUTO_LOGIN_* env vars.`,
      )
      next()
      return
    }
    setAuthCookie(res, result.token)
    // Inject into cookies so downstream requireAuth sees the session on
    // this very request, not just subsequent ones.
    req.cookies = { ...(req.cookies || {}), [AUTH_COOKIE_NAME]: result.token }
  } catch (err) {
    console.warn('[dev-auto-login] unexpected error, skipping:', err)
  }
  next()
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

function requireClinician(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const authReq = req as AuthenticatedRequest
  if (!authReq.authUser?.isAdmin && !authReq.authUser?.isClinician) {
    res.status(403).json({ error: 'Clinician access required.' })
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

  // Surface new-account events on the admin feed. We use `user:<id>` as
  // the deviceId so these events don't collide with the `device:<uuid>`
  // namespace used for anonymous activity; the admin can still tie back
  // to the row in the Sessions tab via the short user-id prefix. Meta
  // carries the display name and email — both are already visible in the
  // Sessions tab, so this doesn't expand the admin's view of user data.
  void trackEvent(`user:${result.user.id}`, 'account_created', {
    displayName: result.user.displayName,
    email: result.user.email,
  }).catch((err) => {
    console.error('Failed to log account_created event', err)
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

// ── Clinician participants ──

const participantSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, 'Participant ID may only contain letters, numbers, dots, underscores, and hyphens.'),
  label: z.string().trim().min(1).max(120),
})

app.get('/api/clinician/participants', requireAuth, requireClinician, async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const participants = await listClinicalParticipants(authReq.authUser.id)
  res.json({ participants })
})

app.put('/api/clinician/participants/:participantId', requireAuth, requireClinician, async (req, res) => {
  const parsed = participantSchema.safeParse({
    ...req.body,
    id: req.params.participantId,
  })
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid participant data.' })
    return
  }
  const authReq = req as AuthenticatedRequest
  const now = new Date().toISOString()
  const participant = await upsertClinicalParticipant(authReq.authUser.id, {
    id: parsed.data.id,
    label: parsed.data.label,
    createdAt: now,
    updatedAt: now,
  })
  res.json({ participant })
})

app.delete('/api/clinician/participants/:participantId', requireAuth, requireClinician, async (req, res) => {
  const id = req.params.participantId.trim()
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
    res.status(400).json({ error: 'Invalid participant ID.' })
    return
  }
  const authReq = req as AuthenticatedRequest
  await deleteClinicalParticipant(authReq.authUser.id, id)
  res.status(204).send()
})

// ── Clinician Workstation Screens ──

const clinicScreenSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, 'Screen ID may only contain letters, numbers, dots, underscores, and hyphens.'),
  label: z.string().trim().min(1).max(120),
  cardWidthPx: z.number().finite().min(100).max(1000),
  screenWidthPx: z.number().int().min(100).max(20000),
  screenHeightPx: z.number().int().min(100).max(20000),
  devicePixelRatio: z.number().finite().min(0.5).max(8),
  viewingDistanceCm: z.number().finite().min(20).max(100).nullable(),
  brightnessFloor: z.number().finite().min(0).max(1).nullable(),
  savedAt: z.string().min(4),
})

app.get('/api/clinician/screens', requireAuth, requireClinician, async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const screens = await listClinicScreens(authReq.authUser.id)
  res.json({ screens })
})

app.put('/api/clinician/screens/:screenId', requireAuth, requireClinician, async (req, res) => {
  const parsed = clinicScreenSchema.safeParse({
    ...req.body,
    id: req.params.screenId,
  })
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid screen data.' })
    return
  }
  const authReq = req as AuthenticatedRequest
  const screen = await upsertClinicScreen(authReq.authUser.id, parsed.data)
  res.json({ screen })
})

app.delete('/api/clinician/screens/:screenId', requireAuth, requireClinician, async (req, res) => {
  const id = req.params.screenId.trim()
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
    res.status(400).json({ error: 'Invalid screen ID.' })
    return
  }
  const authReq = req as AuthenticatedRequest
  await deleteClinicScreen(authReq.authUser.id, id)
  res.status(204).send()
})

app.post('/api/clinician/screens/active', requireAuth, requireClinician, async (req, res) => {
  const schema = z.object({ id: z.string().trim().min(1).max(80).nullable() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body.' })
    return
  }
  const authReq = req as AuthenticatedRequest
  await setActiveClinicScreen(authReq.authUser.id, parsed.data.id)
  res.status(204).send()
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

app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
  const users = await listAllUsers()
  res.json({ users })
})

const clinicianRoleSchema = z.object({
  isClinician: z.boolean(),
})

app.patch('/api/admin/users/:userId/clinician', requireAuth, requireAdmin, async (req, res) => {
  const parsed = clinicianRoleSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid clinician role data.' })
    return
  }

  const updated = await setUserClinicianRole(req.params.userId, parsed.data.isClinician)
  if (!updated) {
    res.status(404).json({ error: 'User not found.' })
    return
  }

  res.json({ user: updated })
})

// Hard-delete a user. Refuse self-delete via this endpoint — admins
// should use /api/users/me so their own session cookie is cleared in
// the same response, instead of accidentally leaving themselves with
// a stale token pointing at a non-existent user.
app.delete('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
  const authReq = req as AuthenticatedRequest
  const targetId = req.params.userId
  if (targetId === authReq.authUser.id) {
    res.status(400).json({ error: 'Use /api/users/me to delete your own account.' })
    return
  }
  await deleteUserAccount(targetId)
  res.status(204).send()
})

app.get('/api/admin/sessions', requireAuth, requireAdmin, async (_req, res) => {
  const sessions = await listAllSessions()
  res.json({ sessions })
})

app.get('/api/admin/vf-results', requireAuth, requireAdmin, async (_req, res) => {
  const results = await listAllVFResults()
  res.json({ results })
})

// Admin drill-down: fetch a single result's full data JSON. `userId` can
// be either a real user id or a `device:<uuid>` synthetic key — both are
// valid composite PK halves for the vf_results table. Encoded via query
// params so the `device:` colon doesn't need URL-escaping in a path
// segment.
app.get('/api/admin/vf-results/detail', requireAuth, requireAdmin, async (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : ''
  const resultId = typeof req.query.id === 'string' ? req.query.id : ''
  if (!userId || !resultId) {
    res.status(400).json({ error: 'Missing userId or id query parameter.' })
    return
  }
  const row = await getAdminVFResultDetail(userId, resultId)
  if (!row) {
    res.status(404).json({ error: 'Result not found.' })
    return
  }
  res.json({ result: row })
})

// Clinician-scope counterpart: returns only study-tagged results
// (anything with a studyId set), regardless of which user ran them.
// "Study-tagged" maps to "ran from the clinician portal" in this app
// — personal account runs stay out of this view.
app.get('/api/clinician/vf-results', requireAuth, requireClinician, async (_req, res) => {
  const all = await listAllVFResults()
  res.json({ results: all.filter(r => r.studyId != null) })
})

app.get('/api/clinician/vf-results/detail', requireAuth, requireClinician, async (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : ''
  const resultId = typeof req.query.id === 'string' ? req.query.id : ''
  if (!userId || !resultId) {
    res.status(400).json({ error: 'Missing userId or id query parameter.' })
    return
  }
  const row = await getAdminVFResultDetail(userId, resultId)
  if (!row) {
    res.status(404).json({ error: 'Result not found.' })
    return
  }
  res.json({ result: row })
})

app.get('/api/admin/surveys', requireAuth, requireAdmin, async (_req, res) => {
  const surveys = await listAllSurveys()
  res.json({ surveys })
})

// ── Anonymous usage events ──

const eventSchema = z.object({
  event: z.enum([
    'test_started',
    'test_completed',
    'test_aborted',
    'page_view',
    'pdf_exported',
    'whatsapp_shared',
    // account_created is fired server-side in /api/auth/register and is
    // listed here for EventType parity; clients don't need to submit it.
    'account_created',
  ]),
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
  if (devAutoLoginEnabled) {
    console.log(
      `[dev-auto-login] enabled as ${DEV_AUTO_LOGIN_EMAIL} ` +
        `(NODE_ENV=${process.env.NODE_ENV}). Unset DEV_AUTO_LOGIN_EMAIL to disable.`,
    )
  }
})
