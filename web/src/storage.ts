import type { TestResult } from './types'
import type { VFResultRecord, VFSurveyRecord } from './api'
import { submitSurvey } from './api'
import type { SurveyResponse } from './components/PostTestSurvey'

const STORAGE_KEY = 'goldmann-vf-results'
const SURVEY_KEY = 'goldmann-vf-surveys'
const DEVICE_ID_KEY = 'goldmann-vf-device-id'
// Tombstone set — IDs the user explicitly deleted locally. Lives here
// because the server's mergeFromServer step would otherwise re-import
// any server record that doesn't exist locally, silently undoing the
// delete the moment the next sync runs. We hold tombstones until the
// server confirms the corresponding DELETE; the auth-context sync
// path tries to clear them on every sync and drops the tombstone on
// 204 (or 404, meaning already gone). This is the only mechanism
// keeping deletes durable when the server-delete network call drops
// or 5xxs, which is exactly when the user previously saw "deleted
// results come back".
const TOMBSTONES_KEY = 'goldmann-vf-tombstones'
// Single device-level flag tracking whether the feedback modal has
// already been shown. We only ask once per device across both
// triggers (Done + Export PDF) so repeat testers don't get nagged.
const FEEDBACK_PROMPTED_KEY = 'goldmann-vf-feedback-prompted'

/**
 * Whether result persistence is enabled for the current session. Only
 * authenticated users should persist results to localStorage — otherwise
 * multiple users on the same device would see each other's history.
 *
 * AuthContext flips this on login/logout via {@link setPersistenceEnabled}.
 * Defaults to false so anonymous tests never accidentally write to storage
 * before the auth hydration completes.
 */
let persistenceEnabled = false

export function setPersistenceEnabled(enabled: boolean): void {
  persistenceEnabled = enabled
}

export function isPersistenceEnabled(): boolean {
  return persistenceEnabled
}

/** Stable anonymous device ID, generated once and persisted in localStorage. */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

/**
 * Snapshot of the current device/browser context, suitable for spreading
 * into a `trackEvent` meta payload. Every value is stringified because
 * `meta` is `Record<string, string>` server-side. Reads only public APIs
 * that don't require permissions; missing/blocked values fall back to ''.
 */
export function getDeviceInfo(): Record<string, string> {
  const tz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '' }
    catch { return '' }
  })()
  return {
    userAgent: navigator.userAgent ?? '',
    platform: navigator.platform ?? '',
    language: navigator.language ?? '',
    screenWidth: String(window.screen?.width ?? 0),
    screenHeight: String(window.screen?.height ?? 0),
    viewportWidth: String(window.innerWidth ?? 0),
    viewportHeight: String(window.innerHeight ?? 0),
    devicePixelRatio: String(window.devicePixelRatio ?? 1),
    timeZone: tz,
    touchPoints: String(navigator.maxTouchPoints ?? 0),
  }
}

export function getResults(): TestResult[] {
  // Anonymous sessions never surface stored results — otherwise residual
  // data from a previous signed-in user on this device would leak to the
  // next anonymous visitor. Server remains the source of truth for real
  // accounts; mergeFromServer will repopulate localStorage after login.
  if (!persistenceEnabled) return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown[]
    // Filter out corrupted entries (missing required fields)
    const valid = parsed.filter((r): r is TestResult =>
      r != null && typeof r === 'object' &&
      'id' in r && 'eye' in r && 'date' in r && 'points' in r &&
      typeof (r as TestResult).id === 'string' &&
      typeof (r as TestResult).date === 'string'
    )
    // If we filtered anything, clean up localStorage
    if (valid.length !== parsed.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(valid))
    }
    return valid
  } catch {
    return []
  }
}

export function saveResult(result: TestResult): void {
  // Anonymous tests are intentionally ephemeral — only authenticated users
  // get history persistence. Callers still receive a valid id via
  // result.id so the in-memory results screen continues to work.
  if (!persistenceEnabled) return
  const results = getResults()
  // Idempotent by id — the test screens re-invoke saveResult if the user
  // signs in after finishing a test (so the just-completed run lands on
  // their new account). Deduping here prevents double-insertion on that
  // transition.
  if (results.some(r => r.id === result.id)) return
  results.push(result)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(results))
}

export function deleteResult(id: string): void {
  const results = getResults().filter(r => r.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(results))
  // Tombstone the id so the next mergeFromServer doesn't quietly
  // re-import it from the server copy. The auth context's sync loop
  // will retry the server-side DELETE until the server agrees, then
  // clear the tombstone.
  addTombstone(id)
}

/** Tombstone API — IDs the user has deleted but where the server
 *  may not yet have caught up. mergeFromServer respects these. */
export function getTombstones(): string[] {
  if (typeof localStorage === 'undefined') return []
  const raw = localStorage.getItem(TOMBSTONES_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function addTombstone(id: string): void {
  if (typeof localStorage === 'undefined') return
  const current = new Set(getTombstones())
  current.add(id)
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([...current]))
}

export function removeTombstone(id: string): void {
  if (typeof localStorage === 'undefined') return
  const remaining = getTombstones().filter(x => x !== id)
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(remaining))
}

/**
 * Wipe cached results/surveys from localStorage. Used on logout so the
 * next signed-in user on the same device doesn't inherit the previous
 * user's history. The server-side copy (per account) is untouched.
 */
export function clearLocalResults(): void {
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(SURVEY_KEY)
  // Clear tombstones too — they're scoped to the logged-in account
  // that issued the deletes. Leaving them around would cause the
  // next user on the device to silently drop their own server
  // results if any happen to share an id (extremely unlikely with
  // UUIDs, but the correctness story is cleaner this way).
  localStorage.removeItem(TOMBSTONES_KEY)
}

// ── Server sync helpers ──

/** Convert local results to the format expected by the sync API */
export function syncToServer(): VFResultRecord[] {
  const all = getResults()
  const valid = all.filter(r => r.id && r.eye && r.date)
  if (all.length !== valid.length) {
    console.warn(`[syncToServer] Filtered out ${all.length - valid.length} invalid results:`,
      all.filter(r => !r.id || !r.eye || !r.date).map(r => ({ id: r.id, eye: r.eye, date: r.date }))
    )
  }
  return valid.map(r => ({
    id: r.id,
    eye: r.eye,
    date: r.date,
    data: JSON.stringify(r),
  }))
}

/** Merge server results into localStorage (adds any missing ones).
 *  Honours the tombstone set — IDs the user explicitly deleted are
 *  skipped, so a server-side copy that hasn't been DELETEd yet
 *  doesn't get re-imported and silently undo the user's action. */
export function mergeFromServer(serverRecords: VFResultRecord[]): void {
  const local = getResults()
  const localIds = new Set(local.map(r => r.id).filter(Boolean))
  const tombstoned = new Set(getTombstones())
  let changed = false

  for (const record of serverRecords) {
    if (!record.id || localIds.has(record.id)) continue
    if (tombstoned.has(record.id)) continue // user deleted this; do not resurrect
    try {
      const result: TestResult = JSON.parse(record.data)
      // Validate that the parsed result has required fields
      if (!result.id || !result.eye || !result.date) continue
      local.push(result)
      localIds.add(result.id)
      changed = true
    } catch {
      // Skip malformed records
    }
  }

  if (changed) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local))
  }
}

// ── Survey storage ──

export interface StoredSurvey {
  id: string
  resultId: string
  date: string
  response: SurveyResponse
}

export function saveSurvey(resultId: string, response: SurveyResponse): void {
  try {
    const raw = localStorage.getItem(SURVEY_KEY)
    const surveys: StoredSurvey[] = raw ? JSON.parse(raw) : []
    const survey: StoredSurvey = {
      id: crypto.randomUUID(),
      resultId,
      date: new Date().toISOString(),
      response,
    }
    surveys.push(survey)
    localStorage.setItem(SURVEY_KEY, JSON.stringify(surveys))

    // Fire-and-forget: send to backend immediately for all users.
    // Surveys are product feedback, not tied to user accounts.
    const record: VFSurveyRecord = {
      id: survey.id,
      resultId: survey.resultId,
      date: survey.date,
      data: JSON.stringify(survey.response),
    }
    submitSurvey(record, getDeviceId()).catch(() => {
      // Network may be unavailable — localStorage is the source of truth
    })
  } catch {
    // Silently fail if storage is full
  }
}

export function getSurveys(): StoredSurvey[] {
  try {
    const raw = localStorage.getItem(SURVEY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function hasSurveyForResult(resultId: string): boolean {
  return getSurveys().some(s => s.resultId === resultId)
}

export function hasBeenPromptedForFeedback(): boolean {
  try {
    return localStorage.getItem(FEEDBACK_PROMPTED_KEY) === '1'
  } catch {
    return false
  }
}

export function markFeedbackPrompted(): void {
  try {
    localStorage.setItem(FEEDBACK_PROMPTED_KEY, '1')
  } catch {
    // Storage may be unavailable / full — at worst we re-prompt once.
  }
}

