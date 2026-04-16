import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb'

import {
  AWS_REGION,
  DDB_USERS_TABLE,
  DDB_SESSIONS_TABLE,
  DDB_VF_RESULTS_TABLE,
  DDB_EVENTS_TABLE,
  SESSION_TTL_MS,
} from './config.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }), {
  marshallOptions: { removeUndefinedValues: true },
})

export type AuthUser = {
  id: string
  email: string
  displayName: string
  isAdmin: boolean
  createdAt: string
}

type UserItem = {
  id: string
  email: string
  displayName: string
  passwordHash: string
  isAdmin?: boolean
  resetPasswordTokenHash?: string
  resetPasswordExpiresAt?: string
  createdAt: string
}

type SessionItem = {
  tokenHash: string
  sessionId: string
  userId: string
  createdAt: string
  expiresAt: string
  lastSeenAt: string
  ttlEpoch: number
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function nowIso(): string {
  return new Date().toISOString()
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

function mapUser(item: UserItem): AuthUser {
  return {
    id: item.id,
    email: item.email,
    displayName: item.displayName,
    isAdmin: Boolean(item.isAdmin),
    createdAt: item.createdAt,
  }
}

/** Quick DynamoDB connectivity check for health endpoint. */
export async function checkDatabaseReady(): Promise<boolean> {
  try {
    // sessions table hash_key is "tokenHash" (not "token")
    await ddb.send(new GetCommand({
      TableName: DDB_SESSIONS_TABLE,
      Key: { tokenHash: '__health_check_probe__' },
    }))
    return true
  } catch (error) {
    console.error('Database readiness check failed', error)
    return false
  }
}

async function findUserById(userId: string): Promise<UserItem | null> {
  const response = await ddb.send(
    new GetCommand({
      TableName: DDB_USERS_TABLE,
      Key: { id: userId },
    }),
  )
  return (response.Item as UserItem | undefined) ?? null
}

async function findUserByEmail(email: string): Promise<UserItem | null> {
  const response = await ddb.send(
    new QueryCommand({
      TableName: DDB_USERS_TABLE,
      IndexName: 'email-index',
      KeyConditionExpression: '#email = :email',
      ExpressionAttributeNames: {
        '#email': 'email',
      },
      ExpressionAttributeValues: {
        ':email': email,
      },
      Limit: 1,
    }),
  )
  return (response.Items?.[0] as UserItem | undefined) ?? null
}

async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  const now = nowIso()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  const ttlEpoch = Math.floor(new Date(expiresAt).getTime() / 1000)

  const item: SessionItem = {
    tokenHash,
    sessionId: randomUUID(),
    userId,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    ttlEpoch,
  }

  await ddb.send(
    new PutCommand({
      TableName: DDB_SESSIONS_TABLE,
      Item: item,
    }),
  )

  return token
}

export async function registerUser(params: {
  email: string
  displayName: string
  password: string
}): Promise<{ token: string; user: AuthUser } | { error: 'email_exists' }> {
  const email = normalizeEmail(params.email)
  const existing = await findUserByEmail(email)
  if (existing) {
    return { error: 'email_exists' }
  }

  const user: UserItem = {
    id: randomUUID(),
    email,
    displayName: params.displayName.trim(),
    passwordHash: hashPassword(params.password),
    createdAt: nowIso(),
  }

  await ddb.send(
    new PutCommand({
      TableName: DDB_USERS_TABLE,
      Item: user,
      ConditionExpression: 'attribute_not_exists(id)',
    }),
  )

  const token = await createSession(user.id)
  return { token, user: mapUser(user) }
}

export async function loginUser(params: {
  email: string
  password: string
}): Promise<{ token: string; user: AuthUser } | { error: 'invalid_credentials' }> {
  const row = await findUserByEmail(normalizeEmail(params.email))
  if (!row || !verifyPassword(params.password, row.passwordHash)) {
    return { error: 'invalid_credentials' }
  }

  const token = await createSession(row.id)
  return { token, user: mapUser(row) }
}

export async function findUserByToken(token: string): Promise<AuthUser | null> {
  const tokenHash = hashToken(token)
  const sessionResponse = await ddb.send(
    new GetCommand({
      TableName: DDB_SESSIONS_TABLE,
      Key: { tokenHash },
    }),
  )
  const session = sessionResponse.Item as SessionItem | undefined
  if (!session) {
    return null
  }

  if (Date.parse(session.expiresAt) <= Date.now()) {
    await ddb.send(new DeleteCommand({ TableName: DDB_SESSIONS_TABLE, Key: { tokenHash } }))
    return null
  }

  await ddb.send(
    new UpdateCommand({
      TableName: DDB_SESSIONS_TABLE,
      Key: { tokenHash },
      UpdateExpression: 'SET lastSeenAt = :lastSeenAt',
      ExpressionAttributeValues: {
        ':lastSeenAt': nowIso(),
      },
    }),
  )

  const user = await findUserById(session.userId)
  if (!user) {
    await ddb.send(new DeleteCommand({ TableName: DDB_SESSIONS_TABLE, Key: { tokenHash } }))
    return null
  }

  return mapUser(user)
}

export async function revokeToken(token: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: DDB_SESSIONS_TABLE, Key: { tokenHash: hashToken(token) } }))
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  const sessionKeys = await listSessionKeysForUser(userId)
  await batchDeleteByKeys(DDB_SESSIONS_TABLE, sessionKeys)
}

export async function updateUserEmail(params: {
  userId: string
  currentPassword: string
  newEmail: string
}): Promise<{ ok: true; user: AuthUser } | { error: 'user_not_found' | 'invalid_credentials' | 'email_exists' }> {
  const row = await findUserById(params.userId)
  if (!row) {
    return { error: 'user_not_found' }
  }
  if (!verifyPassword(params.currentPassword, row.passwordHash)) {
    return { error: 'invalid_credentials' }
  }

  const normalizedEmail = normalizeEmail(params.newEmail)
  const existing = await findUserByEmail(normalizedEmail)
  if (existing && existing.id !== row.id) {
    return { error: 'email_exists' }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: DDB_USERS_TABLE,
      Key: { id: row.id },
      UpdateExpression: 'SET email = :email',
      ExpressionAttributeValues: {
        ':email': normalizedEmail,
      },
    }),
  )
  await revokeAllSessionsForUser(row.id)

  const updatedRow = await findUserById(row.id)
  if (!updatedRow) {
    return { error: 'user_not_found' }
  }
  return { ok: true, user: mapUser(updatedRow) }
}

export async function updateUserPassword(params: {
  userId: string
  currentPassword: string
  newPassword: string
}): Promise<{ ok: true } | { error: 'user_not_found' | 'invalid_credentials' }> {
  const row = await findUserById(params.userId)
  if (!row) {
    return { error: 'user_not_found' }
  }
  if (!verifyPassword(params.currentPassword, row.passwordHash)) {
    return { error: 'invalid_credentials' }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: DDB_USERS_TABLE,
      Key: { id: row.id },
      UpdateExpression: 'SET passwordHash = :passwordHash',
      ExpressionAttributeValues: {
        ':passwordHash': hashPassword(params.newPassword),
      },
    }),
  )
  await revokeAllSessionsForUser(row.id)

  return { ok: true }
}

export async function requestPasswordReset(email: string): Promise<{ email: string; displayName: string; token: string } | null> {
  const normalizedEmail = normalizeEmail(email)
  const row = await findUserByEmail(normalizedEmail)
  if (!row) {
    return null
  }

  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString()

  await ddb.send(
    new UpdateCommand({
      TableName: DDB_USERS_TABLE,
      Key: { id: row.id },
      UpdateExpression: 'SET resetPasswordTokenHash = :tokenHash, resetPasswordExpiresAt = :expiresAt',
      ExpressionAttributeValues: {
        ':tokenHash': tokenHash,
        ':expiresAt': expiresAt,
      },
    }),
  )

  return {
    email: row.email,
    displayName: row.displayName,
    token,
  }
}

export async function resetPasswordWithToken(params: {
  token: string
  newPassword: string
}): Promise<{ ok: true; email: string; displayName: string } | { error: 'invalid_or_expired' }> {
  const tokenHash = hashToken(params.token)
  const now = nowIso()
  let row: UserItem | null = null
  let startKey: Record<string, unknown> | undefined
  do {
    const lookup = await ddb.send(
      new ScanCommand({
        TableName: DDB_USERS_TABLE,
        FilterExpression: 'resetPasswordTokenHash = :tokenHash AND resetPasswordExpiresAt > :now',
        ExpressionAttributeValues: {
          ':tokenHash': tokenHash,
          ':now': now,
        },
        ExclusiveStartKey: startKey,
      }),
    )

    row = ((lookup.Items?.[0] as UserItem | undefined) ?? null) || row
    startKey = lookup.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (!row && startKey)

  if (!row) {
    return { error: 'invalid_or_expired' }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: DDB_USERS_TABLE,
      Key: { id: row.id },
      UpdateExpression:
        'SET passwordHash = :passwordHash REMOVE resetPasswordTokenHash, resetPasswordExpiresAt',
      ExpressionAttributeValues: {
        ':passwordHash': hashPassword(params.newPassword),
      },
    }),
  )
  await revokeAllSessionsForUser(row.id)

  return { ok: true, email: row.email, displayName: row.displayName }
}

async function batchDeleteByKeys(
  tableName: string,
  keys: Record<string, unknown>[],
): Promise<void> {
  if (keys.length === 0) {
    return
  }

  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25)
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: chunk.map((key) => ({ DeleteRequest: { Key: key } })),
        },
      }),
    )
  }
}

async function listSessionKeysForUser(userId: string): Promise<Record<string, unknown>[]> {
  const response = await ddb.send(
    new QueryCommand({
      TableName: DDB_SESSIONS_TABLE,
      IndexName: 'user-id-index',
      KeyConditionExpression: '#userId = :userId',
      ExpressionAttributeNames: {
        '#userId': 'userId',
      },
      ExpressionAttributeValues: {
        ':userId': userId,
      },
      ProjectionExpression: 'tokenHash',
    }),
  )

  return (response.Items ?? []).map((item) => ({ tokenHash: item.tokenHash }))
}

async function listVFKeysForUser(userId: string): Promise<Record<string, unknown>[]> {
  let lastEvaluatedKey: Record<string, unknown> | undefined
  const keys: Record<string, unknown>[] = []

  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: DDB_VF_RESULTS_TABLE,
        KeyConditionExpression: '#userId = :userId',
        ExpressionAttributeNames: {
          '#userId': 'userId',
        },
        ExpressionAttributeValues: {
          ':userId': userId,
        },
        ProjectionExpression: 'userId, logKey',
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    )

    for (const item of response.Items ?? []) {
      keys.push({ userId: item.userId, logKey: item.logKey })
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)

  return keys
}

export async function deleteUserAccount(userId: string): Promise<void> {
  const [sessionKeys, vfKeys] = await Promise.all([
    listSessionKeysForUser(userId),
    listVFKeysForUser(userId),
  ])

  await Promise.all([
    batchDeleteByKeys(DDB_SESSIONS_TABLE, sessionKeys),
    batchDeleteByKeys(DDB_VF_RESULTS_TABLE, vfKeys),
  ])

  await ddb.send(new DeleteCommand({ TableName: DDB_USERS_TABLE, Key: { id: userId } }))
}

export type VFResultRecord = {
  id: string
  eye: string
  date: string
  data: string // JSON-encoded full TestResult
}

export async function addVFResult(userId: string, result: { id: string; eye: string; date: string; data: string }): Promise<VFResultRecord> {
  const logKey = `vf#${result.date}#${result.id}`
  await ddb.send(new PutCommand({
    TableName: DDB_VF_RESULTS_TABLE,
    Item: {
      userId,
      logKey,
      id: result.id,
      eye: result.eye,
      date: result.date,
      data: result.data,
      type: 'vf-result',
    },
  }))
  return result
}

export async function listVFResults(userId: string, limit = 100): Promise<VFResultRecord[]> {
  const response = await ddb.send(new QueryCommand({
    TableName: DDB_VF_RESULTS_TABLE,
    KeyConditionExpression: '#userId = :userId AND begins_with(#logKey, :prefix)',
    ExpressionAttributeNames: { '#userId': 'userId', '#logKey': 'logKey' },
    ExpressionAttributeValues: { ':userId': userId, ':prefix': 'vf#' },
    ScanIndexForward: false,
    Limit: limit,
  }))
  return (response.Items ?? []).map((item: any) => ({
    id: item.id,
    eye: item.eye,
    date: item.date,
    data: item.data,
  }))
}

export async function deleteVFResult(userId: string, resultId: string): Promise<void> {
  // Need to find the item first to get the logKey
  const results = await listVFResults(userId, 200)
  const target = results.find(r => r.id === resultId)
  if (!target) return
  const logKey = `vf#${target.date}#${target.id}`
  await ddb.send(new DeleteCommand({
    TableName: DDB_VF_RESULTS_TABLE,
    Key: { userId, logKey },
  }))
}

export type VFSurveyRecord = {
  id: string
  resultId: string
  date: string
  data: string // JSON-encoded SurveyResponse
}

export async function addVFSurvey(userId: string, survey: { id: string; resultId: string; date: string; data: string }): Promise<VFSurveyRecord> {
  const logKey = `vfsurvey#${survey.date}#${survey.id}`
  await ddb.send(new PutCommand({
    TableName: DDB_VF_RESULTS_TABLE,
    ConditionExpression: 'attribute_not_exists(#logKey)',
    ExpressionAttributeNames: { '#logKey': 'logKey' },
    Item: {
      userId,
      logKey,
      id: survey.id,
      resultId: survey.resultId,
      date: survey.date,
      data: survey.data,
      type: 'vf-survey',
    },
  })).catch((err: any) => {
    if (err?.name !== 'ConditionalCheckFailedException') throw err
    // Already exists — ignore duplicate
  })
  return survey
}

export async function listVFSurveys(userId: string, limit = 200): Promise<VFSurveyRecord[]> {
  const response = await ddb.send(new QueryCommand({
    TableName: DDB_VF_RESULTS_TABLE,
    KeyConditionExpression: '#userId = :userId AND begins_with(#logKey, :prefix)',
    ExpressionAttributeNames: { '#userId': 'userId', '#logKey': 'logKey' },
    ExpressionAttributeValues: { ':userId': userId, ':prefix': 'vfsurvey#' },
    ScanIndexForward: false,
    Limit: limit,
  }))
  return (response.Items ?? []).map((item: any) => ({
    id: item.id,
    resultId: item.resultId,
    date: item.date,
    data: item.data,
  }))
}

// ── Admin ──

export type AdminStats = {
  totalUsers: number
  activeSessions: number
  totalVFResults: number
  totalVFResultsByDevice: number
  totalSurveys: number
  /** VF results per day (last 30 days), sorted oldest first */
  resultsByDay: { date: string; count: number }[]
}

export async function getAdminStats(): Promise<AdminStats> {
  // Count users
  const usersResponse = await ddb.send(new ScanCommand({
    TableName: DDB_USERS_TABLE,
    Select: 'COUNT',
  }))
  const totalUsers = usersResponse.Count ?? 0

  // Count active sessions
  const sessionsResponse = await ddb.send(new ScanCommand({
    TableName: DDB_SESSIONS_TABLE,
    Select: 'COUNT',
  }))
  const activeSessions = sessionsResponse.Count ?? 0

  // Scan VF results + surveys in one pass
  let totalVFResults = 0
  let totalVFResultsByDevice = 0
  let totalSurveys = 0
  const dayCounts = new Map<string, number>()
  let lastKey: Record<string, unknown> | undefined

  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_VF_RESULTS_TABLE,
      ExclusiveStartKey: lastKey,
    }))

    for (const item of response.Items ?? []) {
      const logKey = String(item.logKey ?? '')
      const userId = String(item.userId ?? '')

      if (logKey.startsWith('vfsurvey#')) {
        totalSurveys++
      } else if (logKey.startsWith('vf#')) {
        if (userId.startsWith('device:')) {
          totalVFResultsByDevice++
        } else {
          totalVFResults++
        }
        // Bucket by day for the timeline
        const date = String(item.date ?? '').slice(0, 10) // YYYY-MM-DD
        if (date) {
          dayCounts.set(date, (dayCounts.get(date) ?? 0) + 1)
        }
      }
    }

    lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  // Build last 30 days timeline (fill in zeros for days with no results)
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

// ── Admin: list all login sessions with user info ──

export type AdminSessionRecord = {
  userId: string
  email: string
  displayName: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

export async function listAllSessions(): Promise<AdminSessionRecord[]> {
  // Fetch all sessions
  const sessions: Array<{ userId: string; createdAt: string; lastSeenAt: string; expiresAt: string }> = []
  let lastKey: Record<string, unknown> | undefined
  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_SESSIONS_TABLE,
      ExclusiveStartKey: lastKey,
    }))
    for (const item of response.Items ?? []) {
      sessions.push({
        userId: String(item.userId ?? ''),
        createdAt: String(item.createdAt ?? ''),
        lastSeenAt: String(item.lastSeenAt ?? ''),
        expiresAt: String(item.expiresAt ?? ''),
      })
    }
    lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  // Fetch all users for email/name lookup
  const userMap = new Map<string, { email: string; displayName: string }>()
  let userLastKey: Record<string, unknown> | undefined
  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_USERS_TABLE,
      ProjectionExpression: 'id, email, displayName',
      ExclusiveStartKey: userLastKey,
    }))
    for (const item of response.Items ?? []) {
      userMap.set(String(item.id), {
        email: String(item.email ?? ''),
        displayName: String(item.displayName ?? ''),
      })
    }
    userLastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (userLastKey)

  // Join and sort by lastSeenAt descending
  return sessions
    .map(s => {
      const user = userMap.get(s.userId)
      return {
        userId: s.userId,
        email: user?.email ?? '?',
        displayName: user?.displayName ?? '?',
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
      }
    })
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

// ── Admin: list all VF results (metadata only, no full data blob) ──

export type AdminVFResultRecord = {
  id: string
  userId: string
  eye: string
  date: string
  testType: string | null
  totalPoints: number
  detectedPoints: number
}

export async function listAllVFResults(): Promise<AdminVFResultRecord[]> {
  const results: AdminVFResultRecord[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_VF_RESULTS_TABLE,
      FilterExpression: 'begins_with(#logKey, :prefix)',
      ExpressionAttributeNames: { '#logKey': 'logKey' },
      ExpressionAttributeValues: { ':prefix': 'vf#' },
      ExclusiveStartKey: lastKey,
    }))

    for (const item of response.Items ?? []) {
      let testType: string | null = null
      let totalPoints = 0
      let detectedPoints = 0
      try {
        const data = JSON.parse(String(item.data ?? '{}'))
        testType = data.testType ?? null
        if (Array.isArray(data.points)) {
          totalPoints = data.points.length
          detectedPoints = data.points.filter((p: { detected?: boolean }) => p.detected).length
        }
      } catch { /* skip */ }

      results.push({
        id: String(item.id ?? ''),
        userId: String(item.userId ?? ''),
        eye: String(item.eye ?? ''),
        date: String(item.date ?? ''),
        testType,
        totalPoints,
        detectedPoints,
      })
    }

    lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  results.sort((a, b) => b.date.localeCompare(a.date))
  return results
}

// ── Admin: list all surveys ──

export type AdminSurveyRecord = {
  id: string
  resultId: string
  date: string
  deviceId: string
  perceivedAccuracy: number
  easeOfUse: number
  comparedToClinical: string | null
  freeformFeedback: string
  age: number | null
  yearsDiagnosed: number | null
  rpType: string | null
  currentAid: string | null
  clinicalFieldTest: string | null
}

export async function listAllSurveys(): Promise<AdminSurveyRecord[]> {
  const results: AdminSurveyRecord[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_VF_RESULTS_TABLE,
      FilterExpression: '#type = :vfsurvey',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':vfsurvey': 'vf-survey' },
      ExclusiveStartKey: lastKey,
    }))

    for (const item of response.Items ?? []) {
      try {
        const data = JSON.parse(String(item.data ?? '{}'))
        const userId = String(item.userId ?? '')
        results.push({
          id: String(item.id),
          resultId: String(item.resultId ?? ''),
          date: String(item.date ?? ''),
          deviceId: userId.replace(/^device:/, ''),
          perceivedAccuracy: Number(data.perceivedAccuracy ?? 0),
          easeOfUse: Number(data.easeOfUse ?? 0),
          comparedToClinical: data.comparedToClinical ?? null,
          freeformFeedback: String(data.freeformFeedback ?? ''),
          age: data.age != null ? Number(data.age) : null,
          yearsDiagnosed: data.yearsDiagnosed != null ? Number(data.yearsDiagnosed) : null,
          rpType: data.rpType ?? null,
          currentAid: data.currentAid ?? null,
          clinicalFieldTest: data.clinicalFieldTest ?? null,
        })
      } catch {
        // Skip malformed survey data
      }
    }

    lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  // Newest first
  results.sort((a, b) => b.date.localeCompare(a.date))
  return results
}

// ── Anonymous usage events ──

export type EventType = 'test_started' | 'test_completed' | 'test_aborted' | 'page_view'

export async function trackEvent(deviceId: string, event: EventType, meta?: Record<string, string>): Promise<void> {
  const now = new Date()
  const eventKey = `${now.toISOString()}#${randomUUID().slice(0, 8)}`
  const ttlEpoch = Math.floor(now.getTime() / 1000) + 90 * 86400 // 90 day TTL

  await ddb.send(new PutCommand({
    TableName: DDB_EVENTS_TABLE,
    Item: {
      deviceId,
      eventKey,
      event,
      timestamp: now.toISOString(),
      ...(meta ?? {}),
      ttlEpoch,
    },
  }))
}

export type AdminEventRecord = {
  deviceId: string
  event: string
  timestamp: string
  meta: Record<string, string>
}

export async function listAllEvents(limit = 500): Promise<AdminEventRecord[]> {
  const results: AdminEventRecord[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_EVENTS_TABLE,
      ExclusiveStartKey: lastKey,
    }))

    for (const item of response.Items ?? []) {
      const { deviceId, eventKey, event, timestamp, ttlEpoch, ...meta } = item as Record<string, unknown>
      results.push({
        deviceId: String(deviceId ?? ''),
        event: String(event ?? ''),
        timestamp: String(timestamp ?? ''),
        meta: Object.fromEntries(
          Object.entries(meta).map(([k, v]) => [k, String(v)])
        ),
      })
    }

    lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return results.slice(0, limit)
}
