import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { SESSION_TTL_MS, SQLITE_DB_PATH } from './config.js'
import type { AuthUser, VFResultRecord, VFSurveyRecord, AdminSurveyRecord, AdminStats, AdminSessionRecord, AdminVFResultRecord, EventType, AdminEventRecord } from './ddbStore.js'

type SqlUserRow = {
  id: string
  email: string
  display_name: string
  password_hash: string
  is_admin?: number | null
  reset_token_hash?: string | null
  reset_expires_at?: string | null
  created_at: string
}

type SqlSessionRow = {
  token_hash: string
  user_id: string
  expires_at: string
}

let db: Database.Database | null = null

function sqlitePath(): string {
  return path.isAbsolute(SQLITE_DB_PATH)
    ? SQLITE_DB_PATH
    : path.resolve(process.cwd(), SQLITE_DB_PATH)
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function nowIso(): string {
  return new Date().toISOString()
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hashHex] = storedHash.split(':')
  if (!salt || !hashHex) {
    return false
  }
  const actual = Buffer.from(hashHex, 'hex')
  const expected = scryptSync(password, salt, actual.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function mapUser(row: SqlUserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at,
  }
}

function getDb(): Database.Database {
  if (db) {
    return db
  }

  const filePath = sqlitePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  db = new Database(filePath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      reset_token_hash TEXT,
      reset_expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS vf_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      eye TEXT NOT NULL,
      date TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vf_results_user_date ON vf_results(user_id, date DESC);

    CREATE TABLE IF NOT EXISTS vf_surveys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      result_id TEXT NOT NULL,
      date TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vf_surveys_user_date ON vf_surveys(user_id, date DESC);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      event TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      meta TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
  `)

  // Migration for existing databases
  try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0') } catch { /* already exists */ }

  return db
}

function findUserById(userId: string): SqlUserRow | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ? LIMIT 1').get(userId) as SqlUserRow | undefined
  return row ?? null
}

function findUserByEmail(email: string): SqlUserRow | null {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ? LIMIT 1').get(email) as SqlUserRow | undefined
  return row ?? null
}

function createSession(userId: string): string {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  const now = nowIso()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()

  getDb()
    .prepare(
      `INSERT INTO sessions (
        token_hash, session_id, user_id, created_at, expires_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(tokenHash, randomUUID(), userId, now, expiresAt, now)

  return token
}

/** SQLite is always ready if the process is running. */
export async function checkDatabaseReady(): Promise<boolean> {
  return true
}

export async function registerUser(params: {
  email: string
  displayName: string
  password: string
}): Promise<{ token: string; user: AuthUser } | { error: 'email_exists' }> {
  getDb()

  const email = normalizeEmail(params.email)
  const existing = findUserByEmail(email)
  if (existing) {
    return { error: 'email_exists' }
  }

  const userId = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO users (
        id, email, display_name, password_hash, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, email, params.displayName.trim(), hashPassword(params.password), nowIso())

  const userRow = findUserById(userId)
  if (!userRow) {
    throw new Error('Could not create user')
  }

  const token = createSession(userId)
  return { token, user: mapUser(userRow) }
}

export async function loginUser(params: {
  email: string
  password: string
}): Promise<{ token: string; user: AuthUser } | { error: 'invalid_credentials' }> {
  getDb()

  const row = findUserByEmail(normalizeEmail(params.email))
  if (!row || !verifyPassword(params.password, row.password_hash)) {
    return { error: 'invalid_credentials' }
  }

  const token = createSession(row.id)
  return { token, user: mapUser(row) }
}

export async function findUserByToken(token: string): Promise<AuthUser | null> {
  getDb()

  const tokenHash = hashToken(token)
  const session = getDb()
    .prepare('SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ? LIMIT 1')
    .get(tokenHash) as SqlSessionRow | undefined

  if (!session) {
    return null
  }

  if (Date.parse(session.expires_at) <= Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }

  getDb().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash)

  const user = findUserById(session.user_id)
  if (!user) {
    getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }

  return mapUser(user)
}

export async function revokeToken(token: string): Promise<void> {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

export async function updateUserEmail(params: {
  userId: string
  currentPassword: string
  newEmail: string
}): Promise<{ ok: true; user: AuthUser } | { error: 'user_not_found' | 'invalid_credentials' | 'email_exists' }> {
  const row = findUserById(params.userId)
  if (!row) {
    return { error: 'user_not_found' }
  }
  if (!verifyPassword(params.currentPassword, row.password_hash)) {
    return { error: 'invalid_credentials' }
  }

  const normalizedEmail = normalizeEmail(params.newEmail)
  const existing = findUserByEmail(normalizedEmail)
  if (existing && existing.id !== row.id) {
    return { error: 'email_exists' }
  }

  getDb().prepare('UPDATE users SET email = ? WHERE id = ?').run(normalizedEmail, row.id)
  await revokeAllSessionsForUser(row.id)

  const updated = findUserById(row.id)
  if (!updated) {
    return { error: 'user_not_found' }
  }
  return { ok: true, user: mapUser(updated) }
}

export async function updateUserPassword(params: {
  userId: string
  currentPassword: string
  newPassword: string
}): Promise<{ ok: true } | { error: 'user_not_found' | 'invalid_credentials' }> {
  const row = findUserById(params.userId)
  if (!row) {
    return { error: 'user_not_found' }
  }
  if (!verifyPassword(params.currentPassword, row.password_hash)) {
    return { error: 'invalid_credentials' }
  }

  getDb()
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(params.newPassword), row.id)
  await revokeAllSessionsForUser(row.id)

  return { ok: true }
}

export async function requestPasswordReset(email: string): Promise<{ email: string; displayName: string; token: string } | null> {
  const row = findUserByEmail(normalizeEmail(email))
  if (!row) return null

  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString()

  getDb()
    .prepare('UPDATE users SET reset_token_hash = ?, reset_expires_at = ? WHERE id = ?')
    .run(tokenHash, expiresAt, row.id)

  return { email: row.email, displayName: row.display_name, token }
}

export async function resetPasswordWithToken(params: {
  token: string
  newPassword: string
}): Promise<{ ok: true; email: string; displayName: string } | { error: 'invalid_or_expired' }> {
  const tokenHash = hashToken(params.token)
  const now = new Date().toISOString()

  const row = getDb()
    .prepare('SELECT * FROM users WHERE reset_token_hash = ? AND reset_expires_at > ?')
    .get(tokenHash, now) as SqlUserRow | undefined

  if (!row) return { error: 'invalid_or_expired' }

  getDb()
    .prepare('UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_expires_at = NULL WHERE id = ?')
    .run(hashPassword(params.newPassword), row.id)
  await revokeAllSessionsForUser(row.id)

  return { ok: true, email: row.email, displayName: row.display_name }
}

export async function deleteUserAccount(userId: string): Promise<void> {
  const database = getDb()
  const tx = database.transaction((id: string) => {
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
    database.prepare('DELETE FROM vf_results WHERE user_id = ?').run(id)
    database.prepare('DELETE FROM vf_surveys WHERE user_id = ?').run(id)
    database.prepare('DELETE FROM users WHERE id = ?').run(id)
  })
  tx(userId)
}

export async function addVFResult(userId: string, result: { id: string; eye: string; date: string; data: string }): Promise<VFResultRecord> {
  getDb().prepare(
    'INSERT INTO vf_results (id, user_id, eye, date, data) VALUES (?, ?, ?, ?, ?)'
  ).run(result.id, userId, result.eye, result.date, result.data)
  return result
}

export async function listVFResults(userId: string, limit = 100): Promise<VFResultRecord[]> {
  const rows = getDb().prepare(
    'SELECT id, eye, date, data FROM vf_results WHERE user_id = ? ORDER BY date DESC LIMIT ?'
  ).all(userId, limit) as Array<{ id: string; eye: string; date: string; data: string }>
  return rows
}

export async function deleteVFResult(userId: string, resultId: string): Promise<void> {
  getDb().prepare('DELETE FROM vf_results WHERE id = ? AND user_id = ?').run(resultId, userId)
}

export async function addVFSurvey(userId: string, survey: { id: string; resultId: string; date: string; data: string }): Promise<VFSurveyRecord> {
  getDb().prepare(
    'INSERT OR IGNORE INTO vf_surveys (id, user_id, result_id, date, data) VALUES (?, ?, ?, ?, ?)'
  ).run(survey.id, userId, survey.resultId, survey.date, survey.data)
  return survey
}

export async function listVFSurveys(userId: string, limit = 200): Promise<VFSurveyRecord[]> {
  const rows = getDb().prepare(
    'SELECT id, result_id, date, data FROM vf_surveys WHERE user_id = ? ORDER BY date DESC LIMIT ?'
  ).all(userId, limit) as Array<{ id: string; result_id: string; date: string; data: string }>
  return rows.map(r => ({ id: r.id, resultId: r.result_id, date: r.date, data: r.data }))
}

export async function getAdminStats(): Promise<AdminStats> {
  const database = getDb()
  const totalUsers = (database.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c
  const activeSessions = (database.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c
  const totalVFResults = (database.prepare("SELECT COUNT(*) as c FROM vf_results WHERE user_id NOT LIKE 'device:%'").get() as { c: number }).c
  const totalVFResultsByDevice = (database.prepare("SELECT COUNT(*) as c FROM vf_results WHERE user_id LIKE 'device:%'").get() as { c: number }).c
  const totalSurveys = (database.prepare('SELECT COUNT(*) as c FROM vf_surveys').get() as { c: number }).c

  // Last 30 days VF results by day
  const rows = database.prepare(
    "SELECT substr(date, 1, 10) as day, COUNT(*) as c FROM vf_results WHERE date >= date('now', '-30 days') GROUP BY day ORDER BY day"
  ).all() as Array<{ day: string; c: number }>
  const dayCounts = new Map(rows.map(r => [r.day, r.c]))
  const resultsByDay: { date: string; count: number }[] = []
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    resultsByDay.push({ date: key, count: dayCounts.get(key) ?? 0 })
  }

  return { totalUsers, activeSessions, totalVFResults, totalVFResultsByDevice, totalSurveys, resultsByDay }
}

export async function listAllSessions(): Promise<AdminSessionRecord[]> {
  const rows = getDb().prepare(
    `SELECT s.user_id, u.email, u.display_name, s.created_at, s.last_seen_at, s.expires_at
     FROM sessions s
     LEFT JOIN users u ON s.user_id = u.id
     ORDER BY s.last_seen_at DESC`
  ).all() as Array<{ user_id: string; email: string | null; display_name: string | null; created_at: string; last_seen_at: string; expires_at: string }>

  return rows.map(r => ({
    userId: r.user_id,
    email: r.email ?? '?',
    displayName: r.display_name ?? '?',
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
  }))
}

export async function listAllVFResults(): Promise<AdminVFResultRecord[]> {
  const rows = getDb().prepare(
    'SELECT id, user_id, eye, date, data FROM vf_results ORDER BY date DESC'
  ).all() as Array<{ id: string; user_id: string; eye: string; date: string; data: string }>

  return rows.map(r => {
    let testType: string | null = null
    let totalPoints = 0
    let detectedPoints = 0
    try {
      const data = JSON.parse(r.data)
      testType = data.testType ?? null
      if (Array.isArray(data.points)) {
        totalPoints = data.points.length
        detectedPoints = data.points.filter((p: { detected?: boolean }) => p.detected).length
      }
    } catch { /* skip */ }
    return { id: r.id, userId: r.user_id, eye: r.eye, date: r.date, testType, totalPoints, detectedPoints }
  })
}

export async function listAllSurveys(): Promise<AdminSurveyRecord[]> {
  const rows = getDb().prepare(
    'SELECT id, user_id, result_id, date, data FROM vf_surveys ORDER BY date DESC'
  ).all() as Array<{ id: string; user_id: string; result_id: string; date: string; data: string }>

  return rows.map(r => {
    try {
      const data = JSON.parse(r.data)
      return {
        id: r.id,
        resultId: r.result_id,
        date: r.date,
        deviceId: r.user_id.replace(/^device:/, ''),
        perceivedAccuracy: Number(data.perceivedAccuracy ?? 0),
        easeOfUse: Number(data.easeOfUse ?? 0),
        comparedToClinical: data.comparedToClinical ?? null,
        freeformFeedback: String(data.freeformFeedback ?? ''),
        age: data.age != null ? Number(data.age) : null,
        yearsDiagnosed: data.yearsDiagnosed != null ? Number(data.yearsDiagnosed) : null,
        rpType: data.rpType ?? null,
        currentAid: data.currentAid ?? null,
        clinicalFieldTest: data.clinicalFieldTest ?? null,
      }
    } catch {
      return null
    }
  }).filter((r): r is AdminSurveyRecord => r !== null)
}

export async function trackEvent(deviceId: string, event: EventType, meta?: Record<string, string>): Promise<void> {
  getDb().prepare(
    'INSERT INTO events (device_id, event, timestamp, meta) VALUES (?, ?, ?, ?)'
  ).run(deviceId, event, new Date().toISOString(), meta ? JSON.stringify(meta) : null)
}

export async function listAllEvents(limit = 500): Promise<AdminEventRecord[]> {
  const rows = getDb().prepare(
    'SELECT device_id, event, timestamp, meta FROM events ORDER BY timestamp DESC LIMIT ?'
  ).all(limit) as Array<{ device_id: string; event: string; timestamp: string; meta: string | null }>

  return rows.map(r => ({
    deviceId: r.device_id,
    event: r.event,
    timestamp: r.timestamp,
    meta: r.meta ? JSON.parse(r.meta) : {},
  }))
}
