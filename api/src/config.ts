// api/src/config.ts — single source of truth for environment configuration.
//
// Every env var the API reads goes through this module. Consumers import
// typed constants instead of calling process.env.* directly. This makes
// the surface obvious for contributors (one file to read), reduces drift
// between dev and prod, and is a prerequisite for the plugin registry
// refactor which needs env bootstrap in one place.

import dotenv from 'dotenv'

dotenv.config()

function envString(key: string, fallback: string): string {
  const raw = process.env[key]?.trim()
  return raw && raw.length > 0 ? raw : fallback
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${key}="${raw}" is not a number`)
  }
  return n
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true' || raw === '1' || raw === 'yes') return true
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  throw new Error(`Env var ${key}="${raw}" is not a boolean`)
}

// ── Runtime ─────────────────────────────────────────────────────────

export const NODE_ENV = envString('NODE_ENV', 'development')
export const IS_PRODUCTION = NODE_ENV === 'production'
export const PORT = envNumber('PORT', 8787)

// ── HTTP ────────────────────────────────────────────────────────────

export const FRONTEND_ORIGIN = envString('FRONTEND_ORIGIN', 'http://localhost:5173')
export const FRONTEND_PUBLIC_URL = envString(
  'FRONTEND_PUBLIC_URL',
  FRONTEND_ORIGIN.split(',')[0]?.trim() || 'http://localhost:5173',
)
export const TRUST_PROXY_HOPS = envNumber('TRUST_PROXY_HOPS', 1)

// ── Auth cookies ────────────────────────────────────────────────────

export const AUTH_COOKIE_NAME = envString('AUTH_COOKIE_NAME', 'op_session')
export const AUTH_COOKIE_SECURE = envBool('AUTH_COOKIE_SECURE', IS_PRODUCTION)
export const AUTH_COOKIE_MAX_AGE_MS = envNumber(
  'AUTH_COOKIE_MAX_AGE_MS',
  1000 * 60 * 60 * 24 * 7,
)

// ── Session lifetime (shared by all storage backends) ──────────────

export const SESSION_TTL_MS = envNumber('SESSION_TTL_MS', 1000 * 60 * 60 * 24 * 7)

// ── Rate limits (requests per 60-second window) ────────────────────

export const RATE_LIMIT_WINDOW_MS = envNumber('RATE_LIMIT_WINDOW_MS', 60_000)
export const RATE_LIMIT_REGISTER = envNumber('RATE_LIMIT_REGISTER', 8)
export const RATE_LIMIT_LOGIN = envNumber('RATE_LIMIT_LOGIN', 20)
export const RATE_LIMIT_CONTACT = envNumber('RATE_LIMIT_CONTACT', 5)

// ── Storage backend selection ──────────────────────────────────────
//
// Legacy DATA_BACKEND is still read as a fallback so existing deploys
// don't break; new configs should use STORAGE_BACKEND.

export const STORAGE_BACKEND = envString(
  'STORAGE_BACKEND',
  envString('DATA_BACKEND', IS_PRODUCTION ? 'dynamodb' : 'sqlite'),
).toLowerCase()

// SQLite
export const SQLITE_DB_PATH = envString('SQLITE_DB_PATH', './data/local.sqlite')

// DynamoDB
export const AWS_REGION = envString('AWS_REGION', envString('AWS_DEFAULT_REGION', 'eu-west-1'))
export const DDB_USERS_TABLE = envString('DDB_USERS_TABLE', 'op-users')
export const DDB_SESSIONS_TABLE = envString('DDB_SESSIONS_TABLE', 'op-sessions')
export const DDB_VF_RESULTS_TABLE = envString('DDB_VF_RESULTS_TABLE', 'op-vf-results')
export const DDB_EVENTS_TABLE = envString('DDB_EVENTS_TABLE', 'op-events')
export const DDB_RATE_LIMITS_TABLE = envString('DDB_RATE_LIMITS_TABLE', 'op-rate-limits')

// ── Email backend ──────────────────────────────────────────────────

export const EMAIL_BACKEND = envString(
  'EMAIL_BACKEND',
  envBool('ENABLE_EMAIL_DELIVERY', IS_PRODUCTION) ? 'ses' : 'console',
).toLowerCase()
export const SES_REGION = envString('SES_REGION', AWS_REGION)
export const EMAIL_FROM_ADDRESS = envString('EMAIL_FROM_ADDRESS', '')
export const SUPPORT_EMAIL = envString('SUPPORT_EMAIL', '')
export const CONTACT_RECIPIENT = envString('CONTACT_RECIPIENT', SUPPORT_EMAIL)
