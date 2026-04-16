import type { TestResult } from './types'
import type { VFResultRecord, VFSurveyRecord } from './api'
import { submitSurvey } from './api'
import type { SurveyResponse } from './components/PostTestSurvey'

const STORAGE_KEY = 'goldmann-vf-results'
const SURVEY_KEY = 'goldmann-vf-surveys'
const DEVICE_ID_KEY = 'goldmann-vf-device-id'

/** Stable anonymous device ID, generated once and persisted in localStorage. */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

export function getResults(): TestResult[] {
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
  const results = getResults()
  results.push(result)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(results))
}

export function deleteResult(id: string): void {
  const results = getResults().filter(r => r.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(results))
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

/** Merge server results into localStorage (adds any missing ones) */
export function mergeFromServer(serverRecords: VFResultRecord[]): void {
  const local = getResults()
  const localIds = new Set(local.map(r => r.id).filter(Boolean))
  let changed = false

  for (const record of serverRecords) {
    if (!record.id || localIds.has(record.id)) continue
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

