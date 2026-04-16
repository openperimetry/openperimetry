import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { AuthUser } from './api'
import * as api from './api'
import { syncToServer, mergeFromServer } from './storage'

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, displayName: string, password: string) => Promise<void>
  logout: () => Promise<void>
  syncResults: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  // Check existing session on mount
  useEffect(() => {
    api.getMe()
      .then(res => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const syncResults = useCallback(async () => {
    if (!user) return
    // Debug logging for the batch/individual sync dance. These fire on
    // every auto-sync and were shipping to production browsers before —
    // gate behind the Vite DEV flag so prod consoles stay clean.
    const debug = import.meta.env.DEV
    try {
      const localResults = syncToServer()
      if (debug) console.log(`[Sync] Starting sync: ${localResults.length} local results`)
      if (localResults.length > 0) {
        if (debug) {
          for (const r of localResults) {
            console.log(`[Sync] Result ${r.id}: eye=${r.eye}, date=${r.date}, dataLen=${r.data?.length ?? 'undefined'}`)
          }
        }
        try {
          // Try batch sync first
          const { results: serverResults } = await api.syncVFResults(localResults)
          mergeFromServer(serverResults)
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
          // Fetch final state from server
          const { results: serverResults } = await api.listVFResults()
          mergeFromServer(serverResults)
        }
      } else {
        const { results: serverResults } = await api.listVFResults()
        mergeFromServer(serverResults)
        if (debug) console.log(`[Sync] No local results to push, fetched ${serverResults.length} from server`)
      }
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
  }

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      login: handleLogin,
      register: handleRegister,
      logout: handleLogout,
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
