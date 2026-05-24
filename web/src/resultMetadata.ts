import { APP_VERSION } from './branding'
import type { AdvancedSettings } from './advancedSettings'
import type {
  ResultDeviceMetadata,
  ResultProtocolSnapshot,
  ResultProvenanceMetadata,
  ResultQualityMetrics,
  ResultStudyMetadata,
  RunSpeedMode,
  TestType,
} from './types'
import type { StudyModeState } from './studyMode'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function buildProtocolSnapshot(args: {
  studyMode: StudyModeState
  testType: TestType
  testMode?: 'suprathreshold' | 'threshold'
  speedMode?: RunSpeedMode
  extendedField?: boolean
  staticGridPattern?: string
  advancedSettings: AdvancedSettings
}): ResultProtocolSnapshot {
  const { studyMode, testType, testMode, speedMode, extendedField, staticGridPattern, advancedSettings } = args
  const out: ResultProtocolSnapshot = {
    testType,
    ...(testMode ? { testMode } : {}),
    ...(speedMode ? { speedMode } : {}),
    ...(extendedField != null ? { extendedField } : {}),
    ...(staticGridPattern ? { staticGridPattern } : {}),
    advancedSettingsSnapshot: clone(advancedSettings) as unknown as Record<string, unknown>,
  }
  if (studyMode.enabled && studyMode.profile) {
    out.id = studyMode.profile.id
    out.label = studyMode.profile.label
    out.version = studyMode.profile.version
  }
  return out
}

export function buildStudyMetadata(studyMode: StudyModeState): ResultStudyMetadata | undefined {
  if (!studyMode.enabled || !studyMode.profile) return undefined
  const participantId = studyMode.session.participantId.trim()
  const sessionId = studyMode.session.sessionId.trim()
  if (!participantId || !sessionId) return undefined
  const out: ResultStudyMetadata = {
    studyId: studyMode.profile.studyId,
    protocolId: studyMode.profile.id,
    protocolVersion: studyMode.profile.version,
    participantId,
    sessionId,
  }
  if (studyMode.profile.siteId) out.siteId = studyMode.profile.siteId
  if (studyMode.session.visitId.trim() !== '') out.visitId = studyMode.session.visitId.trim()
  if (studyMode.session.repeatIndex > 1) out.repeatIndex = studyMode.session.repeatIndex
  if (studyMode.session.operatorId.trim() !== '') out.operatorId = studyMode.session.operatorId.trim()
  return out
}

export function captureDeviceMetadata(): ResultDeviceMetadata {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const userAgentData = nav as Navigator & { userAgentData?: { platform?: string } }
  return {
    ...(nav?.userAgent ? { userAgent: nav.userAgent } : {}),
    ...(userAgentData?.userAgentData?.platform || nav?.platform
      ? { platform: userAgentData.userAgentData?.platform ?? nav?.platform }
      : {}),
    ...(nav?.language ? { language: nav.language } : {}),
    ...(Intl?.DateTimeFormat().resolvedOptions().timeZone
      ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      : {}),
    ...(typeof window !== 'undefined' ? { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight } : {}),
    ...(typeof screen !== 'undefined' ? { screenWidth: screen.width, screenHeight: screen.height } : {}),
    ...(typeof window !== 'undefined' ? { pixelRatio: window.devicePixelRatio } : {}),
    ...(typeof document !== 'undefined' ? { fullscreen: document.fullscreenElement != null } : {}),
  }
}

export function buildNativeProvenance(): ResultProvenanceMetadata {
  return {
    source: 'native',
    appVersion: APP_VERSION,
  }
}

export function buildQualityMetrics(metrics: ResultQualityMetrics): ResultQualityMetrics | undefined {
  const entries = Object.entries(metrics).filter(([, value]) => value != null)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries) as ResultQualityMetrics
}

export function buildStudyEventMeta(studyMode: StudyModeState): Record<string, string> {
  const study = buildStudyMetadata(studyMode)
  if (!study) return {}
  const meta: Record<string, string> = {
    studyId: study.studyId,
    participantId: study.participantId,
    sessionId: study.sessionId,
  }
  if (study.protocolId) meta.protocolId = study.protocolId
  if (study.visitId) meta.visitId = study.visitId
  if (study.repeatIndex != null) meta.repeatIndex = String(study.repeatIndex)
  if (study.siteId) meta.siteId = study.siteId
  return meta
}
