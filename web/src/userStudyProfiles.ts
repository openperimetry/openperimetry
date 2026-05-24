// Clinician-authored study profiles persisted to localStorage. These
// sit alongside STANDARD_PROFILES in the portal's Protocols tab so a
// clinician can build a protocol once and reuse it across sessions
// without round-tripping through a JSON file.

import type { StudyProfile } from './studyMode'
import { mergeWithDefaults, validateAdvancedSettings } from './advancedSettings'

const STORAGE_KEY = 'vfc-user-study-profiles'

function isStaticGridPattern(value: unknown): value is StudyProfile['staticGridPattern'] {
  return value === '24-2' || value === '30-2' || value === '10-2' || value === 'custom'
}

function sanitize(raw: unknown): StudyProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || !obj.id.trim()) return null
  if (typeof obj.label !== 'string' || !obj.label.trim()) return null
  if (typeof obj.studyId !== 'string' || !obj.studyId.trim()) return null
  if (typeof obj.version !== 'string' || !obj.version.trim()) return null
  if (obj.testType !== 'goldmann' && obj.testType !== 'static') return null
  if (obj.speedMode !== 'slow' && obj.speedMode !== 'normal') return null
  if (typeof obj.extendedField !== 'boolean') return null
  if (!isStaticGridPattern(obj.staticGridPattern)) return null
  let advancedSettings: StudyProfile['advancedSettings']
  try {
    advancedSettings = mergeWithDefaults(validateAdvancedSettings(obj.advancedSettings))
  } catch {
    return null
  }
  return {
    id: obj.id,
    label: obj.label,
    studyId: obj.studyId,
    version: obj.version,
    testType: obj.testType,
    speedMode: obj.speedMode,
    extendedField: obj.extendedField,
    staticGridPattern: obj.staticGridPattern,
    advancedSettings,
    siteId: typeof obj.siteId === 'string' && obj.siteId.trim() ? obj.siteId : undefined,
    notes: typeof obj.notes === 'string' && obj.notes.trim() ? obj.notes : undefined,
  }
}

function readAll(): StudyProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitize).filter((p): p is StudyProfile => p != null)
  } catch {
    return []
  }
}

function writeAll(profiles: StudyProfile[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
}

export function listUserStudyProfiles(): StudyProfile[] {
  return readAll()
}

/** Slugify a label and append a short random suffix so two profiles
 *  with the same label don't collide. Caller doesn't have to think
 *  about IDs. */
export function makeUserProfileId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const rand = Math.random().toString(36).slice(2, 6)
  return `custom.${slug || 'protocol'}-${rand}`
}

export function upsertUserStudyProfile(profile: StudyProfile): StudyProfile {
  const profiles = readAll()
  const idx = profiles.findIndex(p => p.id === profile.id)
  if (idx >= 0) {
    profiles[idx] = profile
  } else {
    profiles.push(profile)
  }
  writeAll(profiles)
  return profile
}

export function deleteUserStudyProfile(id: string): void {
  writeAll(readAll().filter(p => p.id !== id))
}
