import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { AuthUser, VFResultRecord } from './api'
import * as api from './api'
import { syncToServer, mergeFromServer, applyServerDeletions, setPersistenceEnabled, clearLocalResults, getTombstones } from './storage'

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, displayName: string, password: string) => Promise<void>
  logout: () => Promise<void>
  deleteAccount: () => Promise<void>
  syncResults: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  // Single entry point for mutating the auth user. Flips the storage
  // persistence flag synchronously with the React state update so that
  // child-component effects depending on `user` (e.g. test screens that
  // re-save their result on login) always observe a consistent
  // persistenceEnabled before their effect body runs. React commits
  // effects depth-first — child effects fire before the parent's — so
  // gating persistence via a sibling useEffect in this provider would
  // race against those children.
  const setUser = useCallback((next: AuthUser | null) => {
    setPersistenceEnabled(!!next)
    setUserState(next)
  }, [])

  // Check existing session on mount
  useEffect(() => {
    api.getMe()
      .then(res => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [setUser])

  const syncResults = useCallback(async () => {
    if (!user) return
    // Debug logging for the batch/individual sync dance. These fire on
    // every auto-sync and were shipping to production browsers before —
    // gate behind the Vite DEV flag so prod consoles stay clean.
    const debug = import.meta.env.DEV

    try {
      const localResults = syncToServer()
      if (debug) console.log(`[Sync] Starting sync: ${localResults.length} local results`)

      // Push local results, then settle on the server's authoritative
      // list. syncToServer() already omits tombstoned ids, so we never
      // re-upload something the user just deleted.
      let serverResults: VFResultRecord[]
      let serverDeletedIds: string[] = []
      if (localResults.length > 0) {
        if (debug) {
          for (const r of localResults) {
            console.log(`[Sync] Result ${r.id}: eye=${r.eye}, date=${r.date}, dataLen=${r.data?.length ?? 'undefined'}`)
          }
        }
        try {
          // Try batch sync first
          const res = await api.syncVFResults(localResults)
          serverResults = res.results
          serverDeletedIds = res.deletedIds
          if (debug) console.log(`[Sync] Batch sync success, server has ${serverResults.length} results`)
        } catch (batchErr) {
          // Batch failed (e.g. one result has invalid data) — try individual sync
          console.warn('[Sync] Batch sync failed, trying individual results:', batchErr)
          for (const result of localResults) {
            try {
              if (debug) console.log(`[Sync] Syncing individual result ${result.id} (${result.data?.length ?? 0} bytes)`)
              await api.syncVFResults([result])
              if (debug) console.log(`[Sync] Result ${result.id} synced OK`)
            } catch (singleErr) {
              console.error(`[Sync] Failed to sync result ${result.id}:`, singleErr)
            }
          }
          const final = await api.listVFResults()
          serverResults = final.results
          serverDeletedIds = final.deletedIds
        }
      } else {
        const final = await api.listVFResults()
        serverResults = final.results
        serverDeletedIds = final.deletedIds
        if (debug) console.log(`[Sync] No local results to push, fetched ${serverResults.length} from server`)
      }

      // Propagate cross-device deletes. A result deleted on another device
      // lives only as a server-side tombstone (deletedIds); this device may
      // still hold it locally with no local tombstone. Mirror those
      // tombstones and prune the local copies so we neither display nor
      // re-push them.
      applyServerDeletions(serverDeletedIds)

      // Reconcile this device's own deletes. Tombstones are permanent (see
      // storage.ts), so mergeFromServer below already filters every deleted
      // id out — the row can never be resurrected locally. Here we also
      // push the DELETE through for any tombstoned id the server still
      // holds, retrying on each sync until the server copy is gone. We
      // never clear tombstones, which is what closes the merge/refresh race
      // that previously let deleted results come back.
      const tombstoned = new Set(getTombstones())
      for (const record of serverResults) {
        if (tombstoned.has(record.id)) {
          api.deleteVFResult(record.id).catch(() => { /* retried next sync */ })
        }
      }

      mergeFromServer(serverResults)
    } catch (err) {
      console.error('[Sync] Sync failed:', err)
    }
  }, [user])

  // Auto-sync on login and on page visibility change (tab focus).
  // Debounced to avoid rapid-fire syncs on frequent tab switches.
  useEffect(() => {
    if (!user) return
    syncResults()

    let debounceTimer: number
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(debounceTimer)
        debounceTimer = window.setTimeout(syncResults, 2000)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      clearTimeout(debounceTimer)
    }
  }, [user, syncResults])

  const handleLogin = async (email: string, password: string) => {
    const res = await api.login(email, password)
    setUser(res.user)
  }

  const handleRegister = async (email: string, displayName: string, password: string) => {
    const res = await api.register(email, displayName, password)
    setUser(res.user)
  }

  const handleLogout = async () => {
    await api.logout()
    setUser(null)
    // Wipe cached results so the next user on this device starts clean.
    clearLocalResults()
  }

  const handleDeleteAccount = async () => {
    // Server cascades the delete and clears the auth cookie in the same
    // response, so client-side we just mirror logout: drop the user and
    // wipe locally cached results.
    await api.deleteOwnAccount()
    setUser(null)
    clearLocalResults()
  }

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      login: handleLogin,
      register: handleRegister,
      logout: handleLogout,
      deleteAccount: handleDeleteAccount,
      syncResults,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
