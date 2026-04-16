import fs from 'node:fs'
import path from 'node:path'

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import Database from 'better-sqlite3'

import {
  AWS_REGION,
  DDB_RATE_LIMITS_TABLE,
  STORAGE_BACKEND,
  SQLITE_DB_PATH,
} from './config.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }), {
  marshallOptions: { removeUndefinedValues: true },
})

let sqliteDb: Database.Database | null = null

function sqlitePath(): string {
  return path.isAbsolute(SQLITE_DB_PATH)
    ? SQLITE_DB_PATH
    : path.resolve(process.cwd(), SQLITE_DB_PATH)
}

function getSqliteDb(): Database.Database {
  if (sqliteDb) {
    return sqliteDb
  }

  const filePath = sqlitePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  sqliteDb = new Database(filePath)
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      bucket_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
  `)

  return sqliteDb
}

function toBucketStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs
}

export async function allowRequestPersistent(
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const nowMs = Date.now()
  const bucketStartMs = toBucketStart(nowMs, windowMs)
  const bucketKey = `${key}:${bucketStartMs}`
  const expiresAtMs = bucketStartMs + windowMs

  if (STORAGE_BACKEND === 'sqlite') {
    const db = getSqliteDb()
    db.prepare('DELETE FROM rate_limits WHERE expires_at_ms <= ?').run(nowMs)
    db.prepare(
      `INSERT INTO rate_limits (bucket_key, count, expires_at_ms)
       VALUES (?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1`,
    ).run(bucketKey, expiresAtMs)
    const row = db
      .prepare('SELECT count FROM rate_limits WHERE bucket_key = ? LIMIT 1')
      .get(bucketKey) as { count: number } | undefined
    return Number(row?.count ?? 0) <= limit
  }

  const ttlEpoch = Math.floor(expiresAtMs / 1000)
  const response = await ddb.send(
    new UpdateCommand({
      TableName: DDB_RATE_LIMITS_TABLE,
      Key: { bucketKey },
      UpdateExpression:
        'SET #count = if_not_exists(#count, :zero) + :one, expiresAtMs = :expiresAtMs, ttlEpoch = :ttlEpoch',
      ExpressionAttributeNames: {
        '#count': 'count',
      },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':expiresAtMs': expiresAtMs,
        ':ttlEpoch': ttlEpoch,
      },
      ReturnValues: 'UPDATED_NEW',
    }),
  )
  const nextCount = Number(
    (response.Attributes as { count?: number | string } | undefined)?.count ?? 0,
  )
  return nextCount <= limit
}
