import { API } from './constants'

const BASE = import.meta.env.VITE_API_URL ?? ''

const { MAX_RETRIES, RETRY_DELAY_MS } = API

async function request<T>(path: string, opts: RequestInit = {}, retries: number = MAX_RETRIES): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...opts.headers as Record<string, string> },
    ...opts,
  })
  if (res.status === 204) return undefined as unknown as T

  // Retry on 502/503 (cold start / service unavailable)
  if ((res.status === 502 || res.status === 503) && retries > 0) {
    const delay = RETRY_DELAY_MS * (MAX_RETRIES - retries + 1)
    await new Promise(resolve => setTimeout(resolve, delay))
    return request<T>(path, opts, retries - 1)
  }

  // Handle non-JSON responses (e.g. HTML error pages from CloudFront/App Runner)
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    const text = await res.text().catch(() => '<unreadable>')
    console.error(
      `[API] Non-JSON response: ${res.status} ${res.statusText}\n` +
      `  URL: ${res.url}\n` +
      `  Content-Type: ${contentType || '<none>'}\n` +
      `  Body (first 500 chars): ${text.slice(0, 500)}`
    )
    if (!res.ok) throw new ApiError(res.status, `Server error (${res.status}): ${text.slice(0, 200)}`)
    throw new ApiError(res.status, `Unexpected response format (${contentType || 'no content-type'})`)
  }

  const body = await res.json()
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'Request failed')
  return body
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ── Auth ──

export interface AuthUser {
  id: string
  email: string
  displayName: string
  isAdmin?: boolean
  isClinician?: boolean
}

export async function register(email: string, displayName: string, password: string) {
  return request<{ user: AuthUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, displayName, password }),
  })
}

export async function login(email: string, password: string) {
  return request<{ user: AuthUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function requestPasswordReset(email: string) {
  return request<{ ok: true }>('/api/auth/password-reset/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function confirmPasswordReset(token: string, newPassword: string) {
  return request<{ ok: true }>('/api/auth/password-reset/confirm', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  })
}

export async function getMe() {
  return request<{ user: AuthUser }>('/api/auth/me')
}

export async function logout() {
  return request<void>('/api/auth/logout', { method: 'POST' })
}

// ── Clinician Participants ──

export interface ClinicalParticipantRecord {
  id: string
  label: string
  createdAt: string
  updatedAt: string
}

export async function listClinicalParticipants() {
  return request<{ participants: ClinicalParticipantRecord[] }>('/api/clinician/participants')
}

export async function upsertClinicalParticipant(participant: ClinicalParticipantRecord) {
  return request<{ participant: ClinicalParticipantRecord }>(
    `/api/clinician/participants/${encodeURIComponent(participant.id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(participant),
    },
  )
}

export async function deleteClinicalParticipant(id: string) {
  return request<void>(`/api/clinician/participants/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── Clinician Workstation Screens ──

export interface ClinicScreenRecord {
  id: string
  label: string
  cardWidthPx: number
  screenWidthPx: number
  screenHeightPx: number
  devicePixelRatio: number
  viewingDistanceCm: number | null
  brightnessFloor: number | null
  savedAt: string
  isActive: boolean
}

export async function listClinicScreens() {
  return request<{ screens: ClinicScreenRecord[] }>('/api/clinician/screens')
}

export async function upsertClinicScreen(screen: Omit<ClinicScreenRecord, 'isActive'>) {
  return request<{ screen: ClinicScreenRecord }>(
    `/api/clinician/screens/${encodeURIComponent(screen.id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(screen),
    },
  )
}

export async function deleteClinicScreen(id: string) {
  return request<void>(`/api/clinician/screens/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function setActiveClinicScreen(id: string | null) {
  return request<void>('/api/clinician/screens/active', {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

// ── Visual Field Results ──

export interface VFResultRecord {
  id: string
  eye: string
  date: string
  data: string
}

export async function listVFResults() {
  return request<{ results: VFResultRecord[] }>('/api/users/me/vf-results')
}

export async function syncVFResults(results: VFResultRecord[]) {
  return request<{ results: VFResultRecord[]; added: number }>('/api/users/me/vf-results/sync', {
    method: 'POST',
    body: JSON.stringify(results),
  })
}

export async function deleteVFResult(id: string) {
  return request<void>(`/api/users/me/vf-results/${id}`, { method: 'DELETE' })
}

/** Opt-in anonymous upload. Backs the "Share anonymous result" button on
 *  the results page for logged-out users — same device-UUID convention as
 *  anonymous surveys. `data` is the JSON-stringified full TestResult. */
export async function shareAnonymousVFResult(
  record: { id: string; eye: string; date: string; data: string },
  deviceId: string,
) {
  return request<{ ok: true }>('/api/vf-results/anonymous', {
    method: 'POST',
    body: JSON.stringify({ ...record, deviceId }),
  })
}

// ── Visual Field Surveys ──

export interface VFSurveyRecord {
  id: string
  resultId: string
  date: string
  data: string // JSON-encoded SurveyResponse
}

export async function submitSurvey(survey: VFSurveyRecord, deviceId: string) {
  return request<{ ok: true }>('/api/vf-surveys', {
    method: 'POST',
    body: JSON.stringify({ ...survey, deviceId }),
  })
}

// ── Admin ──

export interface AdminSurveyRecord {
  id: string
  resultId: string
  date: string
  deviceId: string
  perceivedAccuracy: number
  easeOfUse: number
  instructionsClarity: number | null
  comparedToClinical: string | null
  freeformFeedback: string
  age: number | null
  yearsDiagnosed: number | null
  rpType: string | null
  currentAid: string | null
  clinicalFieldTest: string | null
}

export interface AdminStats {
  totalUsers: number
  activeSessions: number
  totalVFResults: number
  totalVFResultsByDevice: number
  totalSurveys: number
  resultsByDay: { date: string; count: number }[]
}

export async function getAdminStats() {
  return request<AdminStats>('/api/admin/stats')
}

export interface AdminVFResultRecord {
  id: string
  userId: string
  eye: string
  date: string
  testType: string | null
  totalPoints: number
  detectedPoints: number
  durationSeconds: number | null
  studyId: string | null
  participantId: string | null
  sessionId: string | null
  visitId: string | null
  repeatIndex: number | null
  protocolId: string | null
  protocolVersion: string | null
}

export interface AdminUserRecord {
  id: string
  email: string
  displayName: string
  isAdmin: boolean
  isClinician: boolean
  createdAt: string
}

export interface AdminSessionRecord {
  userId: string
  email: string
  displayName: string
  isAdmin: boolean
  isClinician: boolean
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

// ── Anonymous events ──

export type EventName =
  | 'test_started'
  | 'test_completed'
  | 'test_aborted'
  | 'page_view'
  | 'pdf_exported'
  | 'whatsapp_shared'
  | 'survey_submitted'
  | 'result_shared_anonymously'
  // account_created is produced server-side on successful /api/auth/register;
  // listed here so AdminPage can type the events list and the badge colour
  // map covers it.
  | 'account_created'

export async function trackEvent(event: EventName, deviceId: string, meta?: Record<string, string>) {
  return request<{ ok: true }>('/api/events', {
    method: 'POST',
    body: JSON.stringify({ event, deviceId, meta }),
  })
}

/**
 * Fire-and-forget event delivery that survives page unload. Uses fetch
 * with `keepalive: true` so the request completes even if the document
 * is torn down (tab close, navigation, pagehide). Body is capped at 64 KB
 * by the keepalive spec — our event meta is well under that.
 *
 * Returns nothing because the page may already be gone before any
 * response would arrive; success is best-effort.
 */
export function trackEventBeacon(event: EventName, deviceId: string, meta?: Record<string, string>): void {
  try {
    void fetch(`${BASE}/api/events`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, deviceId, meta }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // ignore — page is unloading; nothing useful to do with the error
  }
}

export async function getAdminSessions() {
  return request<{ sessions: AdminSessionRecord[] }>('/api/admin/sessions')
}

export async function getAdminUsers() {
  return request<{ users: AdminUserRecord[] }>('/api/admin/users')
}

export async function setAdminUserClinicianRole(userId: string, isClinician: boolean) {
  return request<{ user: AdminUserRecord }>(`/api/admin/users/${encodeURIComponent(userId)}/clinician`, {
    method: 'PATCH',
    body: JSON.stringify({ isClinician }),
  })
}

export async function deleteAdminUser(userId: string) {
  return request<void>(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}

export async function deleteOwnAccount() {
  return request<void>('/api/users/me', { method: 'DELETE' })
}

export async function getAdminVFResults() {
  return request<{ results: AdminVFResultRecord[] }>('/api/admin/vf-results')
}

export async function getClinicianVFResults() {
  return request<{ results: AdminVFResultRecord[] }>('/api/clinician/vf-results')
}

export async function getClinicianVFResultDetail(userId: string, resultId: string) {
  const query = `?userId=${encodeURIComponent(userId)}&id=${encodeURIComponent(resultId)}`
  return request<{ result: AdminVFResultDetail }>(`/api/clinician/vf-results/detail${query}`)
}

/** Admin drill-down: fetches a single result's full `data` JSON (the
 *  stringified TestResult that powers the SensitivityMap). Used by the
 *  AdminPage "view" modal to render a shared result's per-point map. */
export interface AdminVFResultDetail {
  id: string
  userId: string
  eye: string
  date: string
  data: string
}

export async function getAdminVFResultDetail(userId: string, resultId: string) {
  const query = `?userId=${encodeURIComponent(userId)}&id=${encodeURIComponent(resultId)}`
  return request<{ result: AdminVFResultDetail }>(`/api/admin/vf-results/detail${query}`)
}

export interface AdminEventRecord {
  deviceId: string
  event: string
  timestamp: string
  meta: Record<string, string>
}

export async function getAdminEvents() {
  return request<{ events: AdminEventRecord[] }>('/api/admin/events')
}

export async function getAdminSurveys() {
  return request<{ surveys: AdminSurveyRecord[] }>('/api/admin/surveys')
}
