// api/src/authStore.ts — dispatcher that lazily loads the selected
// storage backend. Uses a dynamic import so the DynamoDB/AWS-SDK
// module graph is NOT evaluated when STORAGE_BACKEND=sqlite, and
// vice versa. This lets a public/open-source build ship without the
// ddbStore file at all (the dynamic `await import('./ddbStore.js')`
// throws ERR_MODULE_NOT_FOUND which we surface as a clearer error).
//
// Types re-exported here still come from the sqliteStore module so
// the public build has a stable import surface even when the
// DynamoDB backend file isn't present.

import type * as SqliteStore from './sqliteStore.js'
import { STORAGE_BACKEND } from './config.js'

// Re-export the shared record types from sqliteStore (which imports
// them from ddbStore.js today, but remains available in both builds).
export type {
  AuthUser,
  VFResultRecord,
  VFSurveyRecord,
  AdminSurveyRecord,
  AdminStats,
  AdminSessionRecord,
  AdminVFResultRecord,
  AdminEventRecord,
} from './ddbStore.js'

type StoreModule = typeof SqliteStore

let storePromise: Promise<StoreModule> | null = null

function loadStore(): Promise<StoreModule> {
  if (storePromise) return storePromise
  const name = STORAGE_BACKEND
  storePromise = (async () => {
    if (name === 'sqlite') {
      return (await import('./sqliteStore.js')) as unknown as StoreModule
    }
    if (name === 'dynamodb') {
      try {
        return (await import('./ddbStore.js')) as unknown as StoreModule
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND') {
          throw new Error(
            'STORAGE_BACKEND=dynamodb but ./ddbStore.js is not present in this build. ' +
              'The open-source distribution ships only the sqlite backend; set STORAGE_BACKEND=sqlite ' +
              'or install a fork that includes a ddbStore module.',
          )
        }
        throw err
      }
    }
    throw new Error(`Unknown STORAGE_BACKEND "${name}" — expected "sqlite" or "dynamodb"`)
  })()
  return storePromise
}

// Auto-start loading at module import so the first API call doesn't
// pay the cold-start cost. Swallow the error here — real errors will
// surface when any of the exported functions below are actually called.
void loadStore().catch(() => {
  /* deferred */
})

// Function-by-function forwarders that await the module on first call.
// TypeScript infers the signature from the sqliteStore namespace import.

type StoreFn<K extends keyof StoreModule> = StoreModule[K]

function forward<K extends keyof StoreModule>(key: K): StoreFn<K> {
  return (async (...args: unknown[]) => {
    const mod = await loadStore()
    const fn = mod[key] as unknown as (...a: unknown[]) => unknown
    return fn(...args)
  }) as unknown as StoreFn<K>
}

export const registerUser = forward('registerUser')
export const loginUser = forward('loginUser')
export const findUserByToken = forward('findUserByToken')
export const revokeToken = forward('revokeToken')
export const revokeAllSessionsForUser = forward('revokeAllSessionsForUser')
export const updateUserEmail = forward('updateUserEmail')
export const updateUserPassword = forward('updateUserPassword')
export const requestPasswordReset = forward('requestPasswordReset')
export const resetPasswordWithToken = forward('resetPasswordWithToken')
export const deleteUserAccount = forward('deleteUserAccount')
export const checkDatabaseReady = forward('checkDatabaseReady')
export const addVFResult = forward('addVFResult')
export const listVFResults = forward('listVFResults')
export const deleteVFResult = forward('deleteVFResult')
export const addVFSurvey = forward('addVFSurvey')
export const listVFSurveys = forward('listVFSurveys')
export const getAdminStats = forward('getAdminStats')
export const listAllSessions = forward('listAllSessions')
export const listAllVFResults = forward('listAllVFResults')
export const listAllSurveys = forward('listAllSurveys')
export const trackEvent = forward('trackEvent')
export const listAllEvents = forward('listAllEvents')
