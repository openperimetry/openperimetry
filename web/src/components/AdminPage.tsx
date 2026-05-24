import { useEffect, useMemo, useState } from 'react'
import {
  getAdminStats,
  getAdminUsers,
  setAdminUserClinicianRole,
  deleteAdminUser,
  getAdminSessions,
  getAdminVFResults,
  getAdminSurveys,
  getAdminEvents,
  getAdminVFResultDetail,
  type AdminStats,
  type AdminUserRecord,
  type AdminSessionRecord,
  type AdminVFResultRecord,
  type AdminSurveyRecord,
  type AdminEventRecord,
} from '../api'
import { BackButton } from './AccessibleNav'
import { formatEyeLabelForResult } from '../eyeLabels'
import { SensitivityMap } from './SensitivityMap'
import { VisualFieldMap } from './VisualFieldMap'
import { useAuth } from '../AuthContext'
import type { TestResult } from '../types'
import { isGoldmannResult } from '../types'
import { BUILD_SHA, BUILD_TIME, COMMIT_SOURCE_URL } from '../branding'

interface Props {
  onBack: () => void
}

type Tab = 'events' | 'users' | 'sessions' | 'results' | 'surveys'

const CLINICAL_LABELS: Record<string, string> = {
  never_had_clinical: 'Never had clinical test',
  more_sensitive: 'This detects more',
  similar: 'Similar results',
  less_sensitive: 'Clinical detects more',
}

const TEST_TYPE_LABELS: Record<string, string> = {
  goldmann: 'Goldmann',
  ring: 'Ring',
  static: 'Static',
}

function labelOf(map: Record<string, string>, value: string | null): string {
  if (!value) return '—'
  return map[value] ?? value
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}m ${remainder.toString().padStart(2, '0')}s`
}

export function AdminPage({ onBack }: Props) {
  const { user } = useAuth()
  const adminUserId = user?.id ?? null
  const [tab, setTab] = useState<Tab>('events')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [users, setUsers] = useState<AdminUserRecord[]>([])
  const [events, setEvents] = useState<AdminEventRecord[]>([])
  const [sessions, setSessions] = useState<AdminSessionRecord[]>([])
  const [vfResults, setVfResults] = useState<AdminVFResultRecord[]>([])
  const [surveys, setSurveys] = useState<AdminSurveyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [roleUpdatingUserId, setRoleUpdatingUserId] = useState<string | null>(null)
  const [roleNotice, setRoleNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  // Delete-user modal. `target` is the user being deleted; `typed` is
  // what the admin has typed in the confirmation field. The destructive
  // button only enables once `typed.trim() === target.displayName`.
  const [deleteTarget, setDeleteTarget] = useState<AdminUserRecord | null>(null)
  const [deleteTyped, setDeleteTyped] = useState('')
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null)
  // Drill-down modal for a single VF result. We track just the summary
  // row here and fetch the full `data` JSON lazily — keeps the list
  // payload small but lets the modal render the SensitivityMap without
  // round-trip per keystroke.
  const [detail, setDetail] = useState<{ row: AdminVFResultRecord; result: TestResult | null; error: string | null } | null>(null)
  const pdfExportCount = events.filter(e => e.event === 'pdf_exported').length
  const whatsappShareCount = events.filter(e => e.event === 'whatsapp_shared').length
  // Admin's results view is intentionally narrow: only the anonymously
  // shared results (synthetic `device:<uuid>` userIds). Study-tagged
  // runs live in the clinician portal; personal runs live in the
  // user's own history. Keeps admin focused on app-level moderation,
  // not study management.
  const anonymousResults = useMemo(
    () => vfResults.filter(r => r.userId.startsWith('device:')),
    [vfResults],
  )

  useEffect(() => {
    Promise.all([getAdminStats(), getAdminUsers(), getAdminEvents(), getAdminSessions(), getAdminVFResults(), getAdminSurveys()])
      .then(([statsRes, usersRes, eventsRes, sessionsRes, resultsRes, surveysRes]) => {
        setStats(statsRes)
        setUsers(usersRes.users)
        setEvents(eventsRes.events)
        setSessions(sessionsRes.sessions)
        setVfResults(resultsRes.results)
        setSurveys(surveysRes.surveys)
      })
      .catch(err => setError(err.message ?? 'Failed to load admin data'))
      .finally(() => setLoading(false))
  }, [])

  async function setClinicianRoleForUser(target: AdminUserRecord, isClinician: boolean): Promise<void> {
    setRoleUpdatingUserId(target.id)
    setRoleNotice(null)
    try {
      const { user: updated } = await setAdminUserClinicianRole(target.id, isClinician)
      setUsers(current => current.map(row => row.id === updated.id ? updated : row))
      setSessions(current => current.map(row => (
        row.userId === updated.id
          ? { ...row, isAdmin: updated.isAdmin, isClinician: updated.isClinician }
          : row
      )))
      setRoleNotice({
        tone: 'success',
        message: `${updated.displayName} ${updated.isClinician ? 'can now access' : 'no longer has access to'} clinician tools.`,
      })
    } catch (err) {
      setRoleNotice({ tone: 'error', message: (err as Error).message ?? 'Failed to update clinician role.' })
    } finally {
      setRoleUpdatingUserId(null)
    }
  }

  async function confirmDeleteUser(): Promise<void> {
    if (!deleteTarget) return
    if (deleteTyped.trim() !== deleteTarget.displayName) return
    const target = deleteTarget
    setDeletingUserId(target.id)
    try {
      await deleteAdminUser(target.id)
      setUsers(current => current.filter(row => row.id !== target.id))
      setSessions(current => current.filter(row => row.userId !== target.id))
      setRoleNotice({ tone: 'success', message: `Deleted ${target.displayName} (${target.email}) and all associated data.` })
      setDeleteTarget(null)
      setDeleteTyped('')
    } catch (err) {
      setRoleNotice({ tone: 'error', message: (err as Error).message ?? 'Failed to delete user.' })
    } finally {
      setDeletingUserId(null)
    }
  }

  async function openResultDetail(row: AdminVFResultRecord): Promise<void> {
    setDetail({ row, result: null, error: null })
    try {
      const { result } = await getAdminVFResultDetail(row.userId, row.id)
      const parsed = JSON.parse(result.data) as TestResult
      setDetail({ row, result: parsed, error: null })
    } catch (err) {
      setDetail({ row, result: null, error: (err as Error).message ?? 'Failed to load result' })
    }
  }

  return (
    <div className="min-h-screen bg-page text-white p-6 animate-page-in">
      <main className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Admin</h1>
          <BackButton onClick={onBack} label="Home" />
        </div>

        {/* Deployed build info. SHA + build time are baked in at CI
            time via VITE_BUILD_SHA / VITE_BUILD_TIME. Empty strings in
            local dev builds → render a neutral 'dev' badge instead. */}
        <BuildInfo />


        {/* Stats */}
        {stats && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-7 gap-3">
              <StatCard label="Users" value={stats.totalUsers} />
              <StatCard label="Sessions" value={stats.activeSessions} />
              <StatCard label="VF synced" value={stats.totalVFResults} />
              <StatCard label="Surveys" value={stats.totalSurveys} />
              <StatCard label="PDF exports" value={pdfExportCount} />
              <StatCard label="WhatsApp" value={whatsappShareCount} />
              <StatCard label="VF total" value={stats.totalVFResults + stats.totalVFResultsByDevice} sub={`${stats.totalVFResultsByDevice} anon`} />
            </div>

            {/* Results over time chart */}
            {stats.resultsByDay.some(d => d.count > 0) && (
              <div className="bg-gray-900/50 rounded-xl border border-gray-800/40 p-4 space-y-2">
                <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">Completed tests — last 30 days</p>
                <div className="flex items-end gap-[2px] h-16">
                  {stats.resultsByDay.map((d, i) => {
                    const max = Math.max(...stats.resultsByDay.map(x => x.count), 1)
                    const h = d.count > 0 ? Math.max(4, (d.count / max) * 64) : 0
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`${d.date}: ${d.count}`}>
                        {h > 0 && <div className="w-full bg-blue-500/60 rounded-sm" style={{ height: h }} />}
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between text-xs text-gray-600">
                  <span>{stats.resultsByDay[0]?.date.slice(5)}</span>
                  <span>{stats.resultsByDay[stats.resultsByDay.length - 1]?.date.slice(5)}</span>
                </div>
              </div>
            )}
          </>
        )}

        {/* Tab toggle */}
        <div className="flex bg-gray-900/70 rounded-xl p-1 gap-1">
          {(['events', 'users', 'sessions', 'results', 'surveys'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                tab === t ? 'btn-primary text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-gray-800/80'
              }`}
            >
              {t === 'events' ? `Events (${events.length})`
                : t === 'users' ? `Users (${users.length})`
                : t === 'sessions' ? `Sessions (${sessions.length})`
                : t === 'results' ? `Anon shares (${anonymousResults.length})`
                : `Surveys (${surveys.length})`}
            </button>
          ))}
        </div>

        {loading && (
          <p className="text-gray-400 text-center py-12">Loading...</p>
        )}

        {error && (
          <div role="alert" className="text-red-400 text-sm bg-red-900/20 border border-red-800/30 rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        {/* Events tab */}
        {!loading && !error && tab === 'events' && (
          events.length === 0 ? (
            <p className="text-gray-500 text-center py-12">No events tracked yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-800/60">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-900/80 text-gray-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-3">Time</th>
                    <th className="px-3 py-3">Event</th>
                    <th className="px-3 py-3">Details</th>
                    <th className="px-3 py-3">Device</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/30">
                  {events.map((e, i) => (
                    <tr key={i} className="hover:bg-gray-900/40">
                      <td className="px-3 py-2.5 text-gray-300 whitespace-nowrap">
                        {new Date(e.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        <span className="text-gray-600 ml-1">
                          {new Date(e.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
	                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
	                          e.event === 'test_completed' ? 'bg-green-600/20 text-green-400'
	                          : e.event === 'test_started' ? 'bg-blue-600/20 text-blue-400'
	                          : e.event === 'test_aborted' ? 'bg-amber-600/20 text-amber-400'
	                          : e.event === 'pdf_exported' ? 'bg-violet-600/20 text-violet-400'
	                          : e.event === 'whatsapp_shared' ? 'bg-emerald-600/20 text-emerald-400'
	                          : e.event === 'result_shared_anonymously' ? 'bg-pink-600/20 text-pink-400'
	                          : e.event === 'account_created' ? 'bg-cyan-600/20 text-cyan-400'
	                          : 'bg-gray-700/50 text-gray-300'
	                        }`}>
	                          {e.event.replaceAll('_', ' ')}
	                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-gray-400 text-xs">
                        {Object.entries(e.meta).map(([k, v]) => (
                          <span key={k} className="mr-3">{k}: <span className="text-gray-300">{v}</span></span>
                        ))}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600 font-mono text-xs">{e.deviceId.slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* Users tab */}
        {!loading && !error && tab === 'users' && (
          users.length === 0 ? (
            <p className="text-gray-500 text-center py-12">No users yet.</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-gray-800/60 bg-gray-900/50 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Clinician Access</p>
                <p className="mt-1 text-sm text-gray-300">
                  Users with clinician access can import locked study profiles and see clinician/study mode controls.
                </p>
                {roleNotice && (
                  <p
                    className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                      roleNotice.tone === 'error'
                        ? 'border-red-800/40 bg-red-900/20 text-red-300'
                        : 'border-green-800/40 bg-green-900/20 text-green-300'
                    }`}
                  >
                    {roleNotice.message}
                  </p>
                )}
              </div>

              <div className="overflow-x-auto rounded-xl border border-gray-800/60">
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-900/80 text-gray-400 text-xs uppercase tracking-wider">
                    <tr>
                      <th className="px-3 py-3">User</th>
                      <th className="px-3 py-3">Email</th>
                      <th className="px-3 py-3">Roles</th>
                      <th className="px-3 py-3">Created</th>
                      <th className="px-3 py-3">Clinician Access</th>
                      <th className="px-3 py-3">Delete</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/30">
                    {users.map(row => {
                      const updating = roleUpdatingUserId === row.id
                      const isSelf = row.id === adminUserId
                      return (
                        <tr key={row.id} className="hover:bg-gray-900/40">
                          <td className="px-3 py-2.5">
                            <div className="text-gray-200">{row.displayName}</div>
                            <div className="font-mono text-xs text-gray-600">{row.id.slice(0, 8)}</div>
                          </td>
                          <td className="px-3 py-2.5 text-gray-400">{row.email}</td>
                          <td className="px-3 py-2.5">
                            <RoleBadges isAdmin={row.isAdmin} isClinician={row.isClinician} />
                          </td>
                          <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">
                            {new Date(row.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </td>
                          <td className="px-3 py-2.5">
                            <button
                              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                row.isClinician
                                  ? 'border-teal-500/30 bg-teal-500/10 text-teal-300 hover:bg-teal-500/15'
                                  : 'border-gray-700 bg-gray-900/60 text-gray-300 hover:border-gray-500 hover:text-white'
                              }`}
                              disabled={updating}
                              onClick={() => void setClinicianRoleForUser(row, !row.isClinician)}
                            >
                              {updating ? 'Updating...' : row.isClinician ? 'Clinician enabled' : 'Grant clinician'}
                            </button>
                          </td>
                          <td className="px-3 py-2.5">
                            <button
                              className="rounded-lg border border-red-800/40 bg-red-900/20 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/30 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={isSelf}
                              title={isSelf ? 'Use account settings to delete your own account.' : 'Delete user and all their data.'}
                              onClick={() => { setDeleteTarget(row); setDeleteTyped('') }}
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

        {/* Delete-user confirmation modal. The admin must retype the
            user's displayName exactly before the destructive button
            enables — same pattern GitHub uses for repo deletion, so
            "click through to nuke" is a deliberate two-step action. */}
        {deleteTarget && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-user-title"
            onClick={() => { if (!deletingUserId) { setDeleteTarget(null); setDeleteTyped('') } }}
          >
            <div
              className="w-full max-w-md rounded-2xl border border-red-900/50 bg-gray-950 p-6 shadow-xl"
              onClick={e => e.stopPropagation()}
            >
              <h2 id="delete-user-title" className="text-lg font-semibold text-white">Delete user</h2>
              <p className="mt-3 text-sm text-gray-300">
                This will permanently delete <span className="font-semibold text-white">{deleteTarget.displayName}</span> ({deleteTarget.email}) and all their sessions, test results, surveys, participants, and saved screens. This cannot be undone.
              </p>
              <p className="mt-4 text-xs text-gray-400">
                Type the user's name (<span className="font-mono text-gray-200">{deleteTarget.displayName}</span>) to confirm:
              </p>
              <input
                type="text"
                autoFocus
                value={deleteTyped}
                onChange={e => setDeleteTyped(e.target.value)}
                className="mt-2 w-full rounded-lg border border-gray-800/60 bg-gray-900/80 px-3 py-2 text-sm text-white focus:border-red-500/60 focus:outline-none"
                placeholder={deleteTarget.displayName}
                disabled={deletingUserId === deleteTarget.id}
              />
              <div className="mt-5 flex justify-end gap-2">
                <button
                  className="rounded-lg border border-gray-700 bg-gray-900/60 px-4 py-2 text-sm text-gray-300 hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={deletingUserId === deleteTarget.id}
                  onClick={() => { setDeleteTarget(null); setDeleteTyped('') }}
                >
                  Cancel
                </button>
                <button
                  className="rounded-lg border border-red-700 bg-red-700/40 px-4 py-2 text-sm font-medium text-red-100 hover:bg-red-700/60 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={deleteTyped.trim() !== deleteTarget.displayName || deletingUserId === deleteTarget.id}
                  onClick={() => void confirmDeleteUser()}
                >
                  {deletingUserId === deleteTarget.id ? 'Deleting…' : 'Delete user'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Sessions tab */}
        {!loading && !error && tab === 'sessions' && (
          sessions.length === 0 ? (
            <p className="text-gray-500 text-center py-12">No sessions.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-800/60">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-900/80 text-gray-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-3">User</th>
                    <th className="px-3 py-3">Email</th>
                    <th className="px-3 py-3">Session start</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/30">
                  {sessions.map((s, i) => (
                    <tr key={`${s.userId}-${i}`} className="hover:bg-gray-900/40">
                      <td className="px-3 py-2.5 text-gray-300">{s.displayName}</td>
                      <td className="px-3 py-2.5 text-gray-400">{s.email}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-gray-300">
                        {new Date(s.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        <span className="text-gray-600 ml-1">
                          {new Date(s.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* VF Results tab */}
        {!loading && !error && tab === 'results' && (
          anonymousResults.length === 0 ? (
            <p className="text-gray-500 text-center py-12">No anonymously shared results yet.</p>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                Anonymously shared results only. Study-tagged runs live in the clinician portal; personal account runs in each user's own history.
              </p>
              <div className="overflow-x-auto rounded-xl border border-gray-800/60">
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-900/80 text-gray-400 text-xs uppercase tracking-wider">
                    <tr>
                      <th className="px-3 py-3">Date</th>
                      <th className="px-3 py-3">Eye</th>
                      <th className="px-3 py-3">Test Type</th>
                      <th className="px-3 py-3">Points</th>
                      <th className="px-3 py-3">Duration</th>
                      <th className="px-3 py-3">Device</th>
                      <th className="px-3 py-3 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/30">
                    {anonymousResults.map(r => (
                      <tr key={`${r.userId}-${r.id}`} className="hover:bg-gray-900/40">
                        <td className="px-3 py-2.5 text-gray-300 whitespace-nowrap">
                          {new Date(r.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          <span className="text-gray-600 ml-2">
                            {new Date(r.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            r.eye === 'right' ? 'bg-green-600/20 text-green-400' : r.eye === 'left' ? 'bg-blue-600/20 text-blue-400' : 'bg-purple-600/20 text-purple-400'
                          }`}>
                            {formatEyeLabelForResult(r.eye as 'right' | 'left' | 'both')}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-400">{labelOf(TEST_TYPE_LABELS, r.testType)}</td>
                        <td className="px-3 py-2.5 text-gray-400 font-mono text-xs">
                          <span className="text-green-400">{r.detectedPoints}</span>
                          <span className="text-gray-600">/{r.totalPoints}</span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-400 font-mono text-xs">{formatDuration(r.durationSeconds)}</td>
                        <td className="px-3 py-2.5 text-gray-600 font-mono text-xs">{r.userId.replace(/^device:/, '').slice(0, 8)}</td>
                        <td className="px-3 py-2.5">
                          <button
                            className="text-blue-400 hover:text-blue-300 text-xs"
                            onClick={() => void openResultDetail(r)}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

        {/* Surveys tab */}
        {!loading && !error && tab === 'surveys' && (
          surveys.length === 0 ? (
            <p className="text-gray-500 text-center py-12">No survey responses yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-800/60">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-900/80 text-gray-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-3">Date</th>
                    <th className="px-3 py-3">Accuracy</th>
                    <th className="px-3 py-3">Ease</th>
                    <th className="px-3 py-3">Clarity</th>
                    <th className="px-3 py-3">vs Clinical</th>
                    <th className="px-3 py-3 min-w-[200px]">Feedback</th>
                    <th className="px-3 py-3">Device</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/30">
                  {surveys.map(s => (
                    <tr key={s.id} className="hover:bg-gray-900/40">
                      <td className="px-3 py-2.5 text-gray-300 whitespace-nowrap">
                        {new Date(s.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </td>
                      <td className="px-3 py-2.5 text-center">{ratingBadge(s.perceivedAccuracy)}</td>
                      <td className="px-3 py-2.5 text-center">{ratingBadge(s.easeOfUse)}</td>
                      <td className="px-3 py-2.5 text-center">
                        {s.instructionsClarity != null ? ratingBadge(s.instructionsClarity) : <span className="text-gray-600">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-gray-400">{labelOf(CLINICAL_LABELS, s.comparedToClinical)}</td>
                      <td className="px-3 py-2.5 text-gray-300 max-w-xs">
                        {s.freeformFeedback ? (
                          <span className="line-clamp-2">{s.freeformFeedback}</span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600 font-mono text-xs">{s.deviceId.slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </main>

      {detail && (
        <VFResultDetailModal
          row={detail.row}
          result={detail.result}
          error={detail.error}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

/** Modal that renders a shared result's full point-by-point map. Opens
 *  from the Admin VF Results table; fetches the full `data` JSON lazily
 *  so the list endpoint stays small. The SensitivityMap is identical to
 *  the post-test results screen — admin and user see the same picture,
 *  which makes it much easier to reason about a user's complaint.
 *  Falls back to a meta-only summary for threshold tests whose meta
 *  shape is unrecognised (future-proofing for pre-threshold results). */
function VFResultDetailModal({
  row,
  result,
  error,
  onClose,
}: {
  row: AdminVFResultRecord
  result: TestResult | null
  error: string | null
  onClose: () => void
}) {
  // Static threshold-mode tests carry per-location thresholdDb; derive
  // an array of {meridian, eccentricity, db} for the heatmap. Goldmann
  // and any legacy suprathreshold-tagged static imports carry no
  // thresholdDb and therefore render no heatmap (isopters only, shown
  // separately below).
  const measuredDbPoints = result?.points
    .filter(p => p.thresholdDb != null && !p.catchTrial)
    .map(p => ({
      meridianDeg: p.meridianDeg,
      eccentricityDeg: p.eccentricityDeg,
      db: p.thresholdDb!,
    })) ?? []
  const eye = (result?.eye ?? (row.eye === 'left' ? 'left' : 'right')) as 'left' | 'right'
  const maxEcc = result?.calibration?.maxEccentricityDeg ?? 30
  const isAnonymous = row.userId.startsWith('device:')
  // Goldmann tests render as isopter plots (clinical convention for a
  // suprathreshold sweep). Static tests render as a dB heatmap when they
  // carry per-point thresholds (threshold-mode); legacy suprathreshold
  // static imports render nothing in the heatmap slot.
  const isGoldmann = result !== null && isGoldmannResult(result)
  const nonCatchPoints = result?.points.filter(p => !p.catchTrial) ?? []

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-start justify-center overflow-y-auto p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-950 border border-gray-800 rounded-xl max-w-2xl w-full my-8 p-6 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">VF Result</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {new Date(row.date).toLocaleString('en-GB')} · {formatEyeLabelForResult(eye)} ·{' '}
              {labelOf(TEST_TYPE_LABELS, row.testType)}
              {isAnonymous && <span className="ml-2 text-pink-400">anonymous share</span>}
            </p>
            <p className="text-[10px] text-gray-700 font-mono mt-0.5">
              userId: {row.userId} · id: {row.id}
            </p>
          </div>
          <button className="text-gray-500 hover:text-gray-300 text-xl leading-none" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error && (
          <p className="text-red-400 text-sm">Failed to load: {error}</p>
        )}
        {!error && !result && (
          <p className="text-gray-500 text-sm text-center py-8">Loading…</p>
        )}
        {result && isGoldmann && nonCatchPoints.length > 0 && (
          <div className="flex justify-center">
            <VisualFieldMap
              points={nonCatchPoints}
              eye={eye}
              maxEccentricity={maxEcc}
              size={500}
              showLabels
            />
          </div>
        )}
        {result && !isGoldmann && measuredDbPoints.length > 0 && (
          <div className="flex justify-center">
            <SensitivityMap
              points={measuredDbPoints}
              eye={eye}
              maxEccentricity={maxEcc}
              size={500}
            />
          </div>
        )}
        {result && nonCatchPoints.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-8">
            No points in this result — the full JSON is still available via the admin API.
          </p>
        )}

        {result && (
          <div className="grid grid-cols-2 gap-2 text-xs text-gray-400 pt-2 border-t border-gray-800/60">
            <div>
              <span className="text-gray-600">Points measured:</span>{' '}
              {measuredDbPoints.length}
            </div>
            <div><span className="text-gray-600">Duration:</span> {formatDuration(row.durationSeconds)}</div>
            {result.reliabilityIndices && (
              <>
                <div>
                  <span className="text-gray-600">FP (ISI):</span>{' '}
                  {result.reliabilityIndices.falsePositiveIsiPresses}
                </div>
                <div>
                  <span className="text-gray-600">Catch-trial FPs:</span>{' '}
                  {result.reliabilityIndices.catchTrialsFalsePositive}/
                  {result.reliabilityIndices.catchTrialsPresented}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function BuildInfo() {
  const shortSha = BUILD_SHA ? BUILD_SHA.slice(0, 7) : 'dev'
  // `BUILD_TIME` is ISO-8601 UTC from CI. Render in UTC explicitly so
  // the admin sees the same instant regardless of which tz they're in.
  const builtAt = BUILD_TIME
    ? new Date(BUILD_TIME).toLocaleString('en-GB', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'UTC',
      }) + ' UTC'
    : 'local build'
  // Admin-only link to the source commit. Routed through
  // COMMIT_SOURCE_URL so private deployments can point this at the
  // upstream private repo while public/fork builds get a link to the
  // public mirror (or whatever the operator configured).
  const commitHref = BUILD_SHA && COMMIT_SOURCE_URL
    ? `${COMMIT_SOURCE_URL.replace(/\/+$/, '')}/commit/${BUILD_SHA}`
    : null
  return (
    <div className="rounded-xl border border-gray-800/60 bg-gray-900/40 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-gray-500">Deployed build</span>
        {commitHref ? (
          <a
            href={commitHref}
            target="_blank"
            rel="noopener"
            className="font-mono text-blue-400 hover:text-blue-300 underline decoration-dotted"
          >
            {shortSha}
          </a>
        ) : (
          <span className="font-mono text-gray-300">{shortSha}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-gray-500">Built</span>
        <span className="text-gray-300">{builtAt}</span>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="bg-gray-900/70 rounded-xl p-4 border border-gray-800/60">
      <p className="text-gray-500 text-xs uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-semibold text-white">{value}</p>
      {sub && <p className="text-gray-600 text-xs mt-0.5">{sub}</p>}
    </div>
  )
}

function RoleBadges({ isAdmin, isClinician }: { isAdmin: boolean; isClinician: boolean }) {
  if (!isAdmin && !isClinician) {
    return <span className="text-xs text-gray-600">User</span>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {isAdmin && (
        <span className="rounded bg-blue-600/20 px-2 py-0.5 text-xs font-medium text-blue-300">
          Admin
        </span>
      )}
      {isClinician && (
        <span className="rounded bg-teal-600/20 px-2 py-0.5 text-xs font-medium text-teal-300">
          Clinician
        </span>
      )}
    </div>
  )
}

function ratingBadge(value: number) {
  const color =
    value >= 4 ? 'bg-green-600/20 text-green-400'
    : value === 3 ? 'bg-gray-700/50 text-gray-300'
    : 'bg-red-600/20 text-red-400'
  return (
    <span className={`inline-block w-7 text-center py-0.5 rounded text-xs font-medium ${color}`}>
      {value}
    </span>
  )
}
