import { createContext, useContext } from 'react'
import type { AdvancedSettings } from './advancedSettings'
import {
  DEFAULT_ADVANCED_SETTINGS,
  mergeWithDefaults,
  validateAdvancedSettings,
} from './advancedSettings'
import type { StaticGridPattern } from './grids'
import type { RunSpeedMode, TestType } from './types'

export interface StudyProfile {
  id: string
  label: string
  studyId: string
  version: string
  testType: TestType
  speedMode: RunSpeedMode
  extendedField: boolean
  staticGridPattern: StaticGridPattern
  advancedSettings: AdvancedSettings
  siteId?: string
  notes?: string
}

export interface StudySessionInfo {
  participantId: string
  sessionId: string
  visitId: string
  repeatIndex: number
  operatorId: string
}

export interface StudyModeState {
  enabled: boolean
  profile: StudyProfile | null
  session: StudySessionInfo
}

export interface ExportedStudyProfileDocument {
  vfcStudyProfileVersion: string
  generatedAt: string
  profile: StudyProfile
}

export const STUDY_PROFILE_EXPORT_VERSION = '1.0.0'

export const DEFAULT_STUDY_SESSION: StudySessionInfo = {
  participantId: '',
  sessionId: '',
  visitId: '',
  repeatIndex: 1,
  operatorId: '',
}

export const DEFAULT_STUDY_MODE_STATE: StudyModeState = {
  enabled: false,
  profile: null,
  session: DEFAULT_STUDY_SESSION,
}

const STORAGE_KEY = 'vfc-study-mode'

function isStaticGridPattern(value: unknown): value is StaticGridPattern {
  return value === '24-2' || value === '30-2' || value === '10-2' || value === 'custom'
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function validateStudyProfile(raw: unknown): StudyProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('profile must be an object')
  }
  const obj = raw as Record<string, unknown>
  for (const field of ['id', 'label', 'studyId', 'version'] as const) {
    if (typeof obj[field] !== 'string' || obj[field].trim() === '') {
      throw new Error(`${field} must be a non-empty string`)
    }
  }
  if (obj.testType !== 'goldmann' && obj.testType !== 'static') {
    throw new Error('testType must be goldmann|static')
  }
  if (obj.speedMode !== 'slow' && obj.speedMode !== 'normal') {
    throw new Error('speedMode must be slow|normal')
  }
  if (typeof obj.extendedField !== 'boolean') {
    throw new Error('extendedField must be boolean')
  }
  if (!isStaticGridPattern(obj.staticGridPattern)) {
    throw new Error('staticGridPattern must be 24-2|30-2|10-2|custom')
  }
  const advancedPartial =
    obj.advancedSettings === undefined
      ? DEFAULT_ADVANCED_SETTINGS
      : mergeWithDefaults(validateAdvancedSettings(obj.advancedSettings))
  const profile: StudyProfile = {
    id: (obj.id as string).trim(),
    label: (obj.label as string).trim(),
    studyId: (obj.studyId as string).trim(),
    version: (obj.version as string).trim(),
    testType: obj.testType,
    speedMode: obj.speedMode,
    extendedField: obj.extendedField,
    staticGridPattern: obj.staticGridPattern,
    advancedSettings: clone(advancedPartial),
  }
  if (typeof obj.siteId === 'string' && obj.siteId.trim() !== '') {
    profile.siteId = obj.siteId.trim()
  }
  if (typeof obj.notes === 'string' && obj.notes.trim() !== '') {
    profile.notes = obj.notes.trim()
  }
  return profile
}

function validateStudySession(raw: unknown): StudySessionInfo {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_STUDY_SESSION
  }
  const obj = raw as Record<string, unknown>
  const repeatIndex =
    typeof obj.repeatIndex === 'number' &&
    Number.isInteger(obj.repeatIndex) &&
    obj.repeatIndex >= 1
      ? obj.repeatIndex
      : 1
  return {
    participantId: typeof obj.participantId === 'string' ? obj.participantId : '',
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : '',
    visitId: typeof obj.visitId === 'string' ? obj.visitId : '',
    repeatIndex,
    operatorId: typeof obj.operatorId === 'string' ? obj.operatorId : '',
  }
}

export function loadStudyMode(): StudyModeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STUDY_MODE_STATE
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const profile = parsed.profile == null ? null : validateStudyProfile(parsed.profile)
    return {
      enabled: parsed.enabled === true && profile != null,
      profile,
      session: validateStudySession(parsed.session),
    }
  } catch (e) {
    console.warn('Discarding invalid studyMode in localStorage:', e)
    return DEFAULT_STUDY_MODE_STATE
  }
}

export function saveStudyMode(state: StudyModeState): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      enabled: state.enabled,
      profile: state.profile,
      session: state.session,
    }),
  )
}

export function isStudyReady(state: StudyModeState): boolean {
  // No profile picked → nothing to validate.
  // A profile selected via the clinician portal must also have a
  // participant + session ID before the run can start; `enabled` is
  // not consulted because the home picker leaves that flag off until
  // the moment the test actually launches.
  if (!state.profile) return true
  return state.session.participantId.trim() !== '' && state.session.sessionId.trim() !== ''
}

export function buildStudyProfileExportDocument(
  profile: StudyProfile,
  now: Date = new Date(),
): ExportedStudyProfileDocument {
  return {
    vfcStudyProfileVersion: STUDY_PROFILE_EXPORT_VERSION,
    generatedAt: now.toISOString(),
    profile: clone(profile),
  }
}

export class StudyProfileImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudyProfileImportError'
  }
}

export async function parseStudyProfileFile(file: File): Promise<StudyProfile> {
  let text: string
  try {
    text = await file.text()
  } catch (e) {
    throw new StudyProfileImportError(`could not read file: ${(e as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new StudyProfileImportError(`file is not valid JSON: ${(e as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StudyProfileImportError('file must contain a JSON object')
  }
  const obj = raw as Record<string, unknown>
  const version = obj.vfcStudyProfileVersion
  if (typeof version !== 'string' || !version.startsWith('1.')) {
    throw new StudyProfileImportError(
      `unsupported vfcStudyProfileVersion: ${String(version)} (expected 1.x)`,
    )
  }
  if (obj.profile === undefined) {
    throw new StudyProfileImportError('file is missing a "profile" field')
  }
  try {
    return validateStudyProfile(obj.profile)
  } catch (e) {
    throw new StudyProfileImportError(`invalid profile: ${(e as Error).message}`)
  }
}

export function exportStudyProfileAsFile(profile: StudyProfile): void {
  const doc = buildStudyProfileExportDocument(profile)
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `vfc-study-profile_${profile.id}_${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export const STUDY_MODE_CTX = createContext<StudyModeState>(DEFAULT_STUDY_MODE_STATE)
export const useStudyMode = () => useContext(STUDY_MODE_CTX)

export const STUDY_MODE_SET_CTX = createContext<(next: StudyModeState) => void>(() => {
  throw new Error('useSetStudyMode called outside StudyModeRoot')
})
export const useSetStudyMode = () => useContext(STUDY_MODE_SET_CTX)
