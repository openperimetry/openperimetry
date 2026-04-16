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
}

export interface AdminSessionRecord {
  userId: string
  email: string
  displayName: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

// ── Anonymous events ──

export type EventName = 'test_started' | 'test_completed' | 'test_aborted' | 'page_view' | 'pdf_exported' | 'whatsapp_shared' | 'survey_submitted'

export async function trackEvent(event: EventName, deviceId: string, meta?: Record<string, string>) {
  return request<{ ok: true }>('/api/events', {
    method: 'POST',
    body: JSON.stringify({ event, deviceId, meta }),
  })
}

export async function getAdminSessions() {
  return request<{ sessions: AdminSessionRecord[] }>('/api/admin/sessions')
}

export async function getAdminVFResults() {
  return request<{ results: AdminVFResultRecord[] }>('/api/admin/vf-results')
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
