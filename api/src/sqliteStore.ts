import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { SESSION_TTL_MS, SQLITE_DB_PATH } from './config.js'
import type { AuthUser, ClinicalParticipantRecord, ClinicScreenRecord, VFResultRecord, VFSurveyRecord, AdminSurveyRecord, AdminStats, AdminSessionRecord, AdminVFResultRecord, AdminUserRecord, EventType, AdminEventRecord, EventPage } from './ddbStore.js'

type SqlUserRow = {
  id: string
  email: string
  display_name: string
  password_hash: string
  is_admin?: number | null
  is_clinician?: number | null
  reset_token_hash?: string | null
  reset_expires_at?: string | null
  created_at: string
  last_login_at?: string | null
  total_logins?: number | null
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
    isClinician: Boolean(row.is_clinician),
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
      is_clinician INTEGER DEFAULT 0,
      reset_token_hash TEXT,
      reset_expires_at TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      total_logins INTEGER NOT NULL DEFAULT 0
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

    -- Durable, per-user record of deleted result IDs. A delete is not just
    -- a row removal: other devices still hold the result locally and will
    -- re-push it on their next sync, which would resurrect it. The sync
    -- endpoint consults this table to refuse re-adding a deleted ID, and
    -- returns the set so those devices can prune their local copy.
    CREATE TABLE IF NOT EXISTS vf_deleted_results (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (user_id, id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vf_surveys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      result_id TEXT NOT NULL,
      date TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vf_surveys_user_date ON vf_surveys(user_id, date DESC);

    CREATE TABLE IF NOT EXISTS clinical_participants (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_clinical_participants_user ON clinical_participants(user_id, id);

    CREATE TABLE IF NOT EXISTS clinic_screens (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      card_width_px REAL NOT NULL,
      screen_width_px INTEGER NOT NULL,
      screen_height_px INTEGER NOT NULL,
      device_pixel_ratio REAL NOT NULL,
      viewing_distance_cm REAL,
      brightness_floor REAL,
      saved_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_clinic_screens_user ON clinic_screens(user_id);

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
  try { db.exec('ALTER TABLE users ADD COLUMN is_clinician INTEGER DEFAULT 0') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN total_logins INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }

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

  getDb()
    .prepare('UPDATE users SET last_login_at = ?, total_logins = total_logins + 1 WHERE id = ?')
    .run(now, userId)

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
    database.prepare('DELETE FROM vf_deleted_results WHERE user_id = ?').run(id)
    database.prepare('DELETE FROM vf_surveys WHERE user_id = ?').run(id)
    database.prepare('DELETE FROM clinical_participants WHERE user_id = ?').run(id)
    database.prepare('DELETE FROM clinic_screens WHERE user_id = ?').run(id)
    database.prepare('DELETE FROM users WHERE id = ?').run(id)
  })
  tx(userId)
}

const EXAMPLE_PARTICIPANT: ClinicalParticipantRecord = {
  id: 'P-EXAMPLE-001',
  label: 'Example participant',
  createdAt: '2026-05-13T00:00:00.000Z',
  updatedAt: '2026-05-13T00:00:00.000Z',
}

export async function listClinicalParticipants(userId: string): Promise<ClinicalParticipantRecord[]> {
  const rows = getDb()
    .prepare('SELECT id, label, created_at, updated_at FROM clinical_participants WHERE user_id = ? ORDER BY id')
    .all(userId) as Array<{ id: string; label: string; created_at: string; updated_at: string }>
  if (rows.length > 0) {
    return rows.map(r => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  }
  await upsertClinicalParticipant(userId, EXAMPLE_PARTICIPANT)
  return [EXAMPLE_PARTICIPANT]
}

export async function upsertClinicalParticipant(
  userId: string,
  participant: ClinicalParticipantRecord,
): Promise<ClinicalParticipantRecord> {
  const now = nowIso()
  const updated: ClinicalParticipantRecord = {
    id: participant.id,
    label: participant.label,
    createdAt: participant.createdAt || now,
    updatedAt: now,
  }
  getDb()
    .prepare(
      `INSERT INTO clinical_participants (id, user_id, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id, user_id) DO UPDATE SET
         label = excluded.label,
         updated_at = excluded.updated_at`,
    )
    .run(updated.id, userId, updated.label, updated.createdAt, updated.updatedAt)
  return updated
}

export async function deleteClinicalParticipant(userId: string, participantId: string): Promise<void> {
  getDb().prepare('DELETE FROM clinical_participants WHERE id = ? AND user_id = ?').run(participantId, userId)
}

// ── Clinic Screens ──
//
// One row per named workstation the clinician has set up. The (id,
// user_id) primary key keeps each clinician's registry isolated.
// `is_active` is enforced at most one row per user by the upsert/
// activate helpers below.

interface SqlClinicScreenRow {
  id: string
  label: string
  card_width_px: number
  screen_width_px: number
  screen_height_px: number
  device_pixel_ratio: number
  viewing_distance_cm: number | null
  brightness_floor: number | null
  saved_at: string
  is_active: number
}

function mapClinicScreen(row: SqlClinicScreenRow): ClinicScreenRecord {
  return {
    id: row.id,
    label: row.label,
    cardWidthPx: row.card_width_px,
    screenWidthPx: row.screen_width_px,
    screenHeightPx: row.screen_height_px,
    devicePixelRatio: row.device_pixel_ratio,
    viewingDistanceCm: row.viewing_distance_cm,
    brightnessFloor: row.brightness_floor,
    savedAt: row.saved_at,
    isActive: row.is_active === 1,
  }
}

export async function listClinicScreens(userId: string): Promise<ClinicScreenRecord[]> {
  const rows = getDb()
    .prepare(
      `SELECT id, label, card_width_px, screen_width_px, screen_height_px,
              device_pixel_ratio, viewing_distance_cm, brightness_floor,
              saved_at, is_active
         FROM clinic_screens WHERE user_id = ? ORDER BY saved_at DESC`,
    )
    .all(userId) as SqlClinicScreenRow[]
  return rows.map(mapClinicScreen)
}

export async function upsertClinicScreen(
  userId: string,
  screen: Omit<ClinicScreenRecord, 'isActive'>,
): Promise<ClinicScreenRecord> {
  getDb()
    .prepare(
      `INSERT INTO clinic_screens (
         id, user_id, label, card_width_px, screen_width_px, screen_height_px,
         device_pixel_ratio, viewing_distance_cm, brightness_floor, saved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, user_id) DO UPDATE SET
         label = excluded.label,
         card_width_px = excluded.card_width_px,
         screen_width_px = excluded.screen_width_px,
         screen_height_px = excluded.screen_height_px,
         device_pixel_ratio = excluded.device_pixel_ratio,
         viewing_distance_cm = excluded.viewing_distance_cm,
         brightness_floor = excluded.brightness_floor,
         saved_at = excluded.saved_at`,
    )
    .run(
      screen.id, userId, screen.label, screen.cardWidthPx, screen.screenWidthPx,
      screen.screenHeightPx, screen.devicePixelRatio, screen.viewingDistanceCm,
      screen.brightnessFloor, screen.savedAt,
    )
  const row = getDb()
    .prepare(
      `SELECT id, label, card_width_px, screen_width_px, screen_height_px,
              device_pixel_ratio, viewing_distance_cm, brightness_floor,
              saved_at, is_active
         FROM clinic_screens WHERE user_id = ? AND id = ?`,
    )
    .get(userId, screen.id) as SqlClinicScreenRow
  return mapClinicScreen(row)
}

export async function deleteClinicScreen(userId: string, screenId: string): Promise<void> {
  getDb().prepare('DELETE FROM clinic_screens WHERE id = ? AND user_id = ?').run(screenId, userId)
}

export async function setActiveClinicScreen(userId: string, screenId: string | null): Promise<void> {
  const database = getDb()
  const tx = database.transaction(() => {
    database.prepare('UPDATE clinic_screens SET is_active = 0 WHERE user_id = ?').run(userId)
    if (screenId) {
      database
        .prepare('UPDATE clinic_screens SET is_active = 1 WHERE user_id = ? AND id = ?')
        .run(userId, screenId)
    }
  })
  tx()
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
  const database = getDb()
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM vf_results WHERE id = ? AND user_id = ?').run(resultId, userId)
    // Durable server-side tombstone so another device can't resurrect this
    // result by re-pushing its stale local copy on the next sync.
    database.prepare('INSERT OR IGNORE INTO vf_deleted_results (user_id, id) VALUES (?, ?)').run(userId, resultId)
  })
  tx()
}

export async function listDeletedVFResultIds(userId: string): Promise<string[]> {
  const rows = getDb()
    .prepare('SELECT id FROM vf_deleted_results WHERE user_id = ?')
    .all(userId) as Array<{ id: string }>
  return rows.map(r => r.id)
}

/** Admin: fetch a single result (including the full `data` JSON) by the
 *  composite (userId, resultId) key. Returns null when the row doesn't
 *  exist so the caller can produce a 404. Kept separate from
 *  `listAllVFResults` because the list endpoint deliberately omits the
 *  full blob to keep its payload small; this drill-down is opt-in. */
export async function getAdminVFResultDetail(
  userId: string,
  resultId: string,
): Promise<{ id: string; userId: string; eye: string; date: string; data: string } | null> {
  const row = getDb()
    .prepare('SELECT id, user_id, eye, date, data FROM vf_results WHERE id = ? AND user_id = ? LIMIT 1')
    .get(resultId, userId) as { id: string; user_id: string; eye: string; date: string; data: string } | undefined
  if (!row) return null
  return { id: row.id, userId: row.user_id, eye: row.eye, date: row.date, data: row.data }
}

export async function addVFSurvey(userId: string, survey: { id: string; resultId: string; date: string; data: string }): Promise<VFSurveyRecord> {
  getDb().prepare(
    'INSERT OR IGNORE INTO vf_surveys (id, user_id, result_id, date, data) VALUES (?, ?, ?, ?, ?)'
  ).run(survey.id, userId, survey.resultId, survey.date, survey.data)
  return survey
}

export async function deleteVFSurvey(surveyId: string): Promise<void> {
  getDb().prepare('DELETE FROM vf_surveys WHERE id = ?').run(surveyId)
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
  const totalVFResults = (database.prepare('SELECT COUNT(*) as c FROM vf_results').get() as { c: number }).c
  const totalSurveys = (database.prepare('SELECT COUNT(*) as c FROM vf_surveys').get() as { c: number }).c
  // All-time completed tests. The sqlite events table has no TTL, so a direct
  // COUNT is the true all-time total (the DynamoDB store uses a persistent
  // counter instead, because its events table expires after 90 days).
  const totalTestsCompleted = (database.prepare(
    "SELECT COUNT(*) as c FROM events WHERE event = 'test_completed'"
  ).get() as { c: number }).c

  // Last 30 days completed tests by day — counts test_completed events
  // (server-side timestamps) rather than vf_results sync rows, so the
  // chart reflects how many tests actually finished each day even when
  // the user wasn't signed in (no row written to vf_results).
  const rows = database.prepare(
    "SELECT substr(timestamp, 1, 10) as day, COUNT(*) as c FROM events WHERE event = 'test_completed' AND timestamp >= date('now', '-30 days') GROUP BY day ORDER BY day"
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

  return { totalUsers, activeSessions, totalVFResults, totalSurveys, totalTestsCompleted, resultsByDay }
}

export async function listAllUsers(): Promise<AdminUserRecord[]> {
  const rows = getDb()
    .prepare('SELECT id, email, display_name, is_admin, is_clinician, created_at, last_login_at, total_logins FROM users ORDER BY created_at DESC')
    .all() as Array<{
      id: string
      email: string
      display_name: string
      is_admin?: number | null
      is_clinician?: number | null
      created_at: string
      last_login_at?: string | null
      total_logins?: number | null
    }>

  return rows.map(row => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
    isClinician: Boolean(row.is_clinician),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
    totalLogins: row.total_logins ?? 0,
  }))
}

export async function setUserClinicianRole(userId: string, isClinician: boolean): Promise<AdminUserRecord | null> {
  const row = findUserById(userId)
  if (!row) return null

  getDb()
    .prepare('UPDATE users SET is_clinician = ? WHERE id = ?')
    .run(isClinician ? 1 : 0, userId)

  const updated = findUserById(userId)
  if (!updated) return null
  return {
    id: updated.id,
    email: updated.email,
    displayName: updated.display_name,
    isAdmin: Boolean(updated.is_admin),
    isClinician: Boolean(updated.is_clinician),
    createdAt: updated.created_at,
    lastLoginAt: updated.last_login_at ?? null,
    totalLogins: updated.total_logins ?? 0,
  }
}

export async function listAllSessions(): Promise<AdminSessionRecord[]> {
  const rows = getDb().prepare(
    `SELECT s.user_id, u.email, u.display_name, u.is_admin, u.is_clinician, s.created_at, s.last_seen_at, s.expires_at
     FROM sessions s
     LEFT JOIN users u ON s.user_id = u.id
     ORDER BY s.last_seen_at DESC`
  ).all() as Array<{ user_id: string; email: string | null; display_name: string | null; is_admin?: number | null; is_clinician?: number | null; created_at: string; last_seen_at: string; expires_at: string }>

  return rows.map(r => ({
    userId: r.user_id,
    email: r.email ?? '?',
    displayName: r.display_name ?? '?',
    isAdmin: Boolean(r.is_admin),
    isClinician: Boolean(r.is_clinician),
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
    let durationSeconds: number | null = null
    let studyId: string | null = null
    let participantId: string | null = null
    let sessionId: string | null = null
    let visitId: string | null = null
    let repeatIndex: number | null = null
    let protocolId: string | null = null
    let protocolVersion: string | null = null
    try {
      const data = JSON.parse(r.data)
      testType = data.testType ?? null
      const parsedDuration = Number(data.durationSeconds)
      durationSeconds = Number.isFinite(parsedDuration) ? Math.max(0, Math.round(parsedDuration)) : null
      if (data.study && typeof data.study === 'object') {
        studyId = typeof data.study.studyId === 'string' ? data.study.studyId : null
        participantId = typeof data.study.participantId === 'string' ? data.study.participantId : null
        sessionId = typeof data.study.sessionId === 'string' ? data.study.sessionId : null
        visitId = typeof data.study.visitId === 'string' ? data.study.visitId : null
        const parsedRepeatIndex = Number(data.study.repeatIndex)
        repeatIndex = Number.isFinite(parsedRepeatIndex) ? parsedRepeatIndex : null
        protocolId = typeof data.study.protocolId === 'string' ? data.study.protocolId : null
        protocolVersion = typeof data.study.protocolVersion === 'string' ? data.study.protocolVersion : null
      }
      if (Array.isArray(data.points)) {
        totalPoints = data.points.length
        detectedPoints = data.points.filter((p: { detected?: boolean }) => p.detected).length
      }
    } catch { /* skip */ }
    return {
      id: r.id,
      userId: r.user_id,
      eye: r.eye,
      date: r.date,
      testType,
      totalPoints,
      detectedPoints,
      durationSeconds,
      studyId,
      participantId,
      sessionId,
      visitId,
      repeatIndex,
      protocolId,
      protocolVersion,
    }
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
        instructionsClarity: data.instructionsClarity != null ? Number(data.instructionsClarity) : null,
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

/** One newest-first page of events. Keyset-paginated on the autoincrement id
 *  (insertion order ≈ timestamp order); the cursor is the last id seen, so the
 *  next page is `id < cursor`. */
export async function listEventsPage(limit = 50, cursor?: string): Promise<EventPage> {
  const beforeId = cursor != null && cursor !== '' ? Number(cursor) : null
  const hasCursor = beforeId != null && Number.isFinite(beforeId)
  const sql = hasCursor
    ? 'SELECT id, device_id, event, timestamp, meta FROM events WHERE id < ? ORDER BY id DESC LIMIT ?'
    : 'SELECT id, device_id, event, timestamp, meta FROM events ORDER BY id DESC LIMIT ?'
  const rows = (hasCursor
    ? getDb().prepare(sql).all(beforeId, limit)
    : getDb().prepare(sql).all(limit)) as Array<{ id: number; device_id: string; event: string; timestamp: string; meta: string | null }>

  const events: AdminEventRecord[] = rows.map(r => ({
    deviceId: r.device_id,
    event: r.event,
    timestamp: r.timestamp,
    meta: r.meta ? JSON.parse(r.meta) : {},
  }))
  const nextCursor = rows.length === limit ? String(rows[rows.length - 1].id) : null
  return { events, nextCursor }
}
