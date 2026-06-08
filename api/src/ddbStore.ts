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
  isClinician: boolean
  createdAt: string
}

type UserItem = {
  id: string
  email: string
  displayName: string
  passwordHash: string
  isAdmin?: boolean
  isClinician?: boolean
  resetPasswordTokenHash?: string
  resetPasswordExpiresAt?: string
  createdAt: string
  lastLoginAt?: string
  totalLogins?: number
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
    isClinician: Boolean(item.isClinician),
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

  await ddb.send(
    new UpdateCommand({
      TableName: DDB_USERS_TABLE,
      Key: { id: userId },
      UpdateExpression: 'SET lastLoginAt = :now ADD totalLogins :one',
      ExpressionAttributeValues: { ':now': now, ':one': 1 },
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

async function listParticipantKeysForUser(userId: string): Promise<Record<string, unknown>[]> {
  let lastEvaluatedKey: Record<string, unknown> | undefined
  const keys: Record<string, unknown>[] = []

  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: DDB_USERS_TABLE,
        FilterExpression: '#type = :type AND #ownerUserId = :ownerUserId',
        ExpressionAttributeNames: {
          '#type': 'type',
          '#ownerUserId': 'ownerUserId',
        },
        ExpressionAttributeValues: {
          ':type': 'clinical-participant',
          ':ownerUserId': userId,
        },
        ProjectionExpression: 'id',
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    )

    for (const item of response.Items ?? []) {
      keys.push({ id: item.id })
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)

  return keys
}

export async function deleteUserAccount(userId: string): Promise<void> {
  const [sessionKeys, vfKeys, participantKeys] = await Promise.all([
    listSessionKeysForUser(userId),
    listVFKeysForUser(userId),
    listParticipantKeysForUser(userId),
  ])

  await Promise.all([
    batchDeleteByKeys(DDB_SESSIONS_TABLE, sessionKeys),
    batchDeleteByKeys(DDB_VF_RESULTS_TABLE, vfKeys),
    batchDeleteByKeys(DDB_USERS_TABLE, participantKeys),
  ])

  await ddb.send(new DeleteCommand({ TableName: DDB_USERS_TABLE, Key: { id: userId } }))
}

export type VFResultRecord = {
  id: string
  eye: string
  date: string
  data: string // JSON-encoded full TestResult
}

export type ClinicalParticipantRecord = {
  id: string
  label: string
  createdAt: string
  updatedAt: string
}

export type ClinicScreenRecord = {
  id: string
  label: string
  cardWidthPx: number
  screenWidthPx: number
  screenHeightPx: number
  devicePixelRatio: number
  viewingDistanceCm: number | null
  brightnessFloor: number | null
  savedAt: string
  isActive: boolean
}

const EXAMPLE_PARTICIPANT: ClinicalParticipantRecord = {
  id: 'P-EXAMPLE-001',
  label: 'Example participant',
  createdAt: '2026-05-13T00:00:00.000Z',
  updatedAt: '2026-05-13T00:00:00.000Z',
}

function participantStorageId(userId: string, participantId: string): string {
  return `clinical-participant#${userId}#${participantId}`
}

function mapParticipantItem(item: any): ClinicalParticipantRecord {
  return {
    id: item.participantId,
    label: item.label,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

export async function listClinicalParticipants(userId: string): Promise<ClinicalParticipantRecord[]> {
  const participants: ClinicalParticipantRecord[] = []
  let lastEvaluatedKey: Record<string, unknown> | undefined

  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_USERS_TABLE,
      FilterExpression: '#type = :type AND #ownerUserId = :ownerUserId',
      ExpressionAttributeNames: {
        '#type': 'type',
        '#ownerUserId': 'ownerUserId',
      },
      ExpressionAttributeValues: {
        ':type': 'clinical-participant',
        ':ownerUserId': userId,
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }))

    participants.push(...(response.Items ?? []).map(mapParticipantItem))
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)

  if (participants.length > 0) return participants.sort((a, b) => a.id.localeCompare(b.id))

  const example = { ...EXAMPLE_PARTICIPANT }
  await upsertClinicalParticipant(userId, example)
  return [example]
}

export async function upsertClinicalParticipant(
  userId: string,
  participant: ClinicalParticipantRecord,
): Promise<ClinicalParticipantRecord> {
  const now = nowIso()
  const createdAt = participant.createdAt || now
  const updated: ClinicalParticipantRecord = {
    ...participant,
    createdAt,
    updatedAt: now,
  }
  await ddb.send(new PutCommand({
    TableName: DDB_USERS_TABLE,
    Item: {
      id: participantStorageId(userId, updated.id),
      type: 'clinical-participant',
      ownerUserId: userId,
      participantId: updated.id,
      label: updated.label,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
  }))
  return updated
}

export async function deleteClinicalParticipant(userId: string, participantId: string): Promise<void> {
  await ddb.send(new DeleteCommand({
    TableName: DDB_USERS_TABLE,
    Key: { id: participantStorageId(userId, participantId) },
  }))
}

// ── Clinic Screens ──
//
// Stored in DDB_USERS_TABLE under `type=clinic-screen` items so the
// existing scan-by-type pattern can list them per-user. Active selection
// is stored as an `is_active` flag on the screen item itself; setActive
// scans the user's screens and toggles the flag in two writes.

function clinicScreenStorageId(userId: string, screenId: string): string {
  return `clinic-screen#${userId}#${screenId}`
}

function mapClinicScreenItem(item: any): ClinicScreenRecord {
  return {
    id: item.screenId,
    label: item.label,
    cardWidthPx: Number(item.cardWidthPx),
    screenWidthPx: Number(item.screenWidthPx),
    screenHeightPx: Number(item.screenHeightPx),
    devicePixelRatio: Number(item.devicePixelRatio),
    viewingDistanceCm: item.viewingDistanceCm == null ? null : Number(item.viewingDistanceCm),
    brightnessFloor: item.brightnessFloor == null ? null : Number(item.brightnessFloor),
    savedAt: item.savedAt,
    isActive: item.isActive === true,
  }
}

export async function listClinicScreens(userId: string): Promise<ClinicScreenRecord[]> {
  const screens: ClinicScreenRecord[] = []
  let lastEvaluatedKey: Record<string, unknown> | undefined
  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_USERS_TABLE,
      FilterExpression: '#type = :type AND #ownerUserId = :ownerUserId',
      ExpressionAttributeNames: {
        '#type': 'type',
        '#ownerUserId': 'ownerUserId',
      },
      ExpressionAttributeValues: {
        ':type': 'clinic-screen',
        ':ownerUserId': userId,
      },
      ExclusiveStartKey: lastEvaluatedKey,
    }))
    screens.push(...(response.Items ?? []).map(mapClinicScreenItem))
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)
  return screens.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

export async function upsertClinicScreen(
  userId: string,
  screen: Omit<ClinicScreenRecord, 'isActive'>,
): Promise<ClinicScreenRecord> {
  // Preserve the existing active flag on update so re-saving doesn't
  // silently deactivate the user's selection. setActiveClinicScreen is
  // the only function that mutates is_active.
  const existing = await ddb.send(new GetCommand({
    TableName: DDB_USERS_TABLE,
    Key: { id: clinicScreenStorageId(userId, screen.id) },
  }))
  const wasActive = existing.Item?.isActive === true
  await ddb.send(new PutCommand({
    TableName: DDB_USERS_TABLE,
    Item: {
      id: clinicScreenStorageId(userId, screen.id),
      type: 'clinic-screen',
      ownerUserId: userId,
      screenId: screen.id,
      label: screen.label,
      cardWidthPx: screen.cardWidthPx,
      screenWidthPx: screen.screenWidthPx,
      screenHeightPx: screen.screenHeightPx,
      devicePixelRatio: screen.devicePixelRatio,
      viewingDistanceCm: screen.viewingDistanceCm,
      brightnessFloor: screen.brightnessFloor,
      savedAt: screen.savedAt,
      isActive: wasActive,
    },
  }))
  return { ...screen, isActive: wasActive }
}

export async function deleteClinicScreen(userId: string, screenId: string): Promise<void> {
  await ddb.send(new DeleteCommand({
    TableName: DDB_USERS_TABLE,
    Key: { id: clinicScreenStorageId(userId, screenId) },
  }))
}

export async function setActiveClinicScreen(userId: string, screenId: string | null): Promise<void> {
  const screens = await listClinicScreens(userId)
  // Clear flag on everything that isn't the new target, set it on the
  // target. Sequential is fine — a clinician toggling active state
  // won't have hundreds of workstations.
  for (const s of screens) {
    const shouldBeActive = s.id === screenId
    if (s.isActive === shouldBeActive) continue
    await ddb.send(new PutCommand({
      TableName: DDB_USERS_TABLE,
      Item: {
        id: clinicScreenStorageId(userId, s.id),
        type: 'clinic-screen',
        ownerUserId: userId,
        screenId: s.id,
        label: s.label,
        cardWidthPx: s.cardWidthPx,
        screenWidthPx: s.screenWidthPx,
        screenHeightPx: s.screenHeightPx,
        devicePixelRatio: s.devicePixelRatio,
        viewingDistanceCm: s.viewingDistanceCm,
        brightnessFloor: s.brightnessFloor,
        savedAt: s.savedAt,
        isActive: shouldBeActive,
      },
    }))
  }
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

/** Admin: fetch a single result (including the full `data` JSON) by the
 *  composite (userId, resultId) key. Returns null when the row doesn't
 *  exist. Mirrors the sqlite implementation so the admin drill-down
 *  works against either backend. DynamoDB requires the full `logKey`,
 *  so we Query on `userId` and filter client-side by `id` — cheap
 *  because a single user typically has a small number of results. */
export async function getAdminVFResultDetail(
  userId: string,
  resultId: string,
): Promise<{ id: string; userId: string; eye: string; date: string; data: string } | null> {
  const results = await listVFResults(userId, 200)
  const target = results.find(r => r.id === resultId)
  if (!target) return null
  return { id: target.id, userId, eye: target.eye, date: target.date, data: target.data }
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
  totalSurveys: number
  /** VF results per day (last 30 days), sorted oldest first */
  resultsByDay: { date: string; count: number }[]
}

export async function getAdminStats(): Promise<AdminStats> {
  // Count users
  const usersResponse = await ddb.send(new ScanCommand({
    TableName: DDB_USERS_TABLE,
    Select: 'COUNT',
    FilterExpression: 'attribute_not_exists(#type)',
    ExpressionAttributeNames: { '#type': 'type' },
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
  let totalSurveys = 0
  let lastKey: Record<string, unknown> | undefined

  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_VF_RESULTS_TABLE,
      ExclusiveStartKey: lastKey,
    }))

    for (const item of response.Items ?? []) {
      const logKey = String(item.logKey ?? '')

      if (logKey.startsWith('vfsurvey#')) {
        totalSurveys++
      } else if (logKey.startsWith('vf#')) {
        totalVFResults++
      }
    }

    lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  // Last 30 days completed tests by day — counts `test_completed`
  // events (server-timestamped at fire time) rather than vf_results
  // rows, so the chart reflects how many tests actually finished each
  // day even when the user wasn't signed in (no vf_results row).
  const dayCounts = new Map<string, number>()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffIso = cutoff.toISOString()
  let eventsKey: Record<string, unknown> | undefined
  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_EVENTS_TABLE,
      FilterExpression: '#event = :ev AND #ts >= :cutoff',
      ExpressionAttributeNames: { '#event': 'event', '#ts': 'timestamp' },
      ExpressionAttributeValues: { ':ev': 'test_completed', ':cutoff': cutoffIso },
      ExclusiveStartKey: eventsKey,
    }))
    for (const item of response.Items ?? []) {
      const day = String(item.timestamp ?? '').slice(0, 10)
      if (day) dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1)
    }
    eventsKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (eventsKey)

  // Build last 30 days timeline (fill in zeros for days with no events)
  const resultsByDay: { date: string; count: number }[] = []
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    resultsByDay.push({ date: key, count: dayCounts.get(key) ?? 0 })
  }

  return { totalUsers, activeSessions, totalVFResults, totalSurveys, resultsByDay }
}

// ── Admin: list all login sessions with user info ──

export type AdminSessionRecord = {
  userId: string
  email: string
  displayName: string
  isAdmin: boolean
  isClinician: boolean
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

export type AdminUserRecord = {
  id: string
  email: string
  displayName: string
  isAdmin: boolean
  isClinician: boolean
  createdAt: string
  lastLoginAt: string | null
  totalLogins: number
}

export async function listAllUsers(): Promise<AdminUserRecord[]> {
  const users: AdminUserRecord[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_USERS_TABLE,
      FilterExpression: 'attribute_not_exists(#type)',
      ProjectionExpression: '#id, email, displayName, isAdmin, isClinician, createdAt, lastLoginAt, totalLogins',
      ExpressionAttributeNames: { '#id': 'id', '#type': 'type' },
      ExclusiveStartKey: lastKey,
    }))

    for (const item of response.Items ?? []) {
      users.push({
        id: String(item.id ?? ''),
        email: String(item.email ?? ''),
        displayName: String(item.displayName ?? ''),
        isAdmin: Boolean(item.isAdmin),
        isClinician: Boolean(item.isClinician),
        createdAt: String(item.createdAt ?? ''),
        lastLoginAt: item.lastLoginAt != null ? String(item.lastLoginAt) : null,
        totalLogins: Number(item.totalLogins ?? 0),
      })
    }

    lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  users.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return users
}

export async function setUserClinicianRole(userId: string, isClinician: boolean): Promise<AdminUserRecord | null> {
  const existing = await findUserById(userId)
  if (!existing) return null

  await ddb.send(new UpdateCommand({
    TableName: DDB_USERS_TABLE,
    Key: { id: userId },
    UpdateExpression: 'SET isClinician = :isClinician',
    ExpressionAttributeValues: { ':isClinician': isClinician },
  }))

  const updated = await findUserById(userId)
  if (!updated) return null
  return {
    id: updated.id,
    email: updated.email,
    displayName: updated.displayName,
    isAdmin: Boolean(updated.isAdmin),
    isClinician: Boolean(updated.isClinician),
    createdAt: updated.createdAt,
    lastLoginAt: updated.lastLoginAt ?? null,
    totalLogins: Number(updated.totalLogins ?? 0),
  }
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
  const userMap = new Map<string, { email: string; displayName: string; isAdmin: boolean; isClinician: boolean }>()
  let userLastKey: Record<string, unknown> | undefined
  do {
    const response = await ddb.send(new ScanCommand({
      TableName: DDB_USERS_TABLE,
      FilterExpression: 'attribute_not_exists(#type)',
      ProjectionExpression: '#id, email, displayName, isAdmin, isClinician',
      ExpressionAttributeNames: { '#id': 'id', '#type': 'type' },
      ExclusiveStartKey: userLastKey,
    }))
    for (const item of response.Items ?? []) {
      userMap.set(String(item.id), {
        email: String(item.email ?? ''),
        displayName: String(item.displayName ?? ''),
        isAdmin: Boolean(item.isAdmin),
        isClinician: Boolean(item.isClinician),
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
        isAdmin: user?.isAdmin ?? false,
        isClinician: user?.isClinician ?? false,
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
  durationSeconds: number | null
  studyId: string | null
  participantId: string | null
  sessionId: string | null
  visitId: string | null
  repeatIndex: number | null
  protocolId: string | null
  protocolVersion: string | null
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
      let durationSeconds: number | null = null
      let studyId: string | null = null
      let participantId: string | null = null
      let sessionId: string | null = null
      let visitId: string | null = null
      let repeatIndex: number | null = null
      let protocolId: string | null = null
      let protocolVersion: string | null = null
      try {
        const data = JSON.parse(String(item.data ?? '{}'))
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

      results.push({
        id: String(item.id ?? ''),
        userId: String(item.userId ?? ''),
        eye: String(item.eye ?? ''),
        date: String(item.date ?? ''),
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
  instructionsClarity: number | null
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
          instructionsClarity: data.instructionsClarity != null ? Number(data.instructionsClarity) : null,
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

export type EventType =
  | 'test_started'
  | 'test_completed'
  | 'test_aborted'
  | 'page_view'
  | 'pdf_exported'
  | 'whatsapp_shared'
  | 'account_created'

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
