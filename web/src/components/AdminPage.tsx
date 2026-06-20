import { useEffect, useState } from 'react'
import {
  getAdminStats,
  getAdminUsers,
  setAdminUserClinicianRole,
  deleteAdminUser,
  getAdminSurveys,
  deleteAdminSurvey,
  getAdminEvents,
  type AdminStats,
  type AdminUserRecord,
  type AdminSurveyRecord,
  type AdminEventRecord,
} from '../api'
import { BackButton } from './AccessibleNav'
import { useAuth } from '../AuthContext'
import { BUILD_SHA, BUILD_TIME, COMMIT_SOURCE_URL } from '../branding'

interface Props {
  onBack: () => void
}

type Tab = 'events' | 'users' | 'surveys'

/** Events fetched (and shown) per page in the admin feed. */
const EVENTS_PAGE_SIZE = 50

export function AdminPage({ onBack }: Props) {
  const { user } = useAuth()
  const adminUserId = user?.id ?? null
  const [tab, setTab] = useState<Tab>('events')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [users, setUsers] = useState<AdminUserRecord[]>([])
  const [events, setEvents] = useState<AdminEventRecord[]>([])
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
  // Survey deletion. `confirmSurveyId` is the row currently showing its
  // inline Confirm/Cancel affordance; `deletingSurveyId` is the row whose
  // DELETE is in flight (button shows a busy state, disabled).
  const [confirmSurveyId, setConfirmSurveyId] = useState<string | null>(null)
  const [deletingSurveyId, setDeletingSurveyId] = useState<string | null>(null)
  // Cursor pagination for the events feed. `eventCursor` is the cursor that
  // produced the current page (undefined = first/newest page); `nextCursor`
  // advances to the next (older) page; `cursorStack` remembers the cursors of
  // the pages we came through so Back can return to them.
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)

  useEffect(() => {
    Promise.all([getAdminStats(), getAdminUsers(), getAdminEvents({ limit: EVENTS_PAGE_SIZE }), getAdminSurveys()])
      .then(([statsRes, usersRes, eventsRes, surveysRes]) => {
        setStats(statsRes)
        setUsers(usersRes.users)
        setEvents(eventsRes.events)
        setNextCursor(eventsRes.nextCursor)
        setSurveys(surveysRes.surveys)
      })
      .catch(err => setError(err.message ?? 'Failed to load admin data'))
      .finally(() => setLoading(false))
  }, [])

  async function loadEventsPage(cursor: string | undefined): Promise<void> {
    setEventsLoading(true)
    try {
      const page = await getAdminEvents({ cursor, limit: EVENTS_PAGE_SIZE })
      setEvents(page.events)
      setNextCursor(page.nextCursor)
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load events')
    } finally {
      setEventsLoading(false)
    }
  }

  function goToNextEventsPage(): void {
    if (!nextCursor || eventsLoading) return
    const cursor = nextCursor
    setCursorStack(s => [...s, cursor])
    void loadEventsPage(cursor)
  }

  function goToPrevEventsPage(): void {
    if (cursorStack.length === 0 || eventsLoading) return
    const stack = cursorStack.slice(0, -1)
    setCursorStack(stack)
    // The page before the current one was produced by the cursor now at the top
    // of the trimmed stack (undefined → the first/newest page).
    void loadEventsPage(stack[stack.length - 1])
  }

  async function setClinicianRoleForUser(target: AdminUserRecord, isClinician: boolean): Promise<void> {
    setRoleUpdatingUserId(target.id)
    setRoleNotice(null)
    try {
      const { user: updated } = await setAdminUserClinicianRole(target.id, isClinician)
      setUsers(current => current.map(row => row.id === updated.id ? updated : row))
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
      setRoleNotice({ tone: 'success', message: `Deleted ${target.displayName} (${target.email}) and all associated data.` })
      setDeleteTarget(null)
      setDeleteTyped('')
    } catch (err) {
      setRoleNotice({ tone: 'error', message: (err as Error).message ?? 'Failed to delete user.' })
    } finally {
      setDeletingUserId(null)
    }
  }

  async function confirmDeleteSurvey(id: string): Promise<void> {
    setDeletingSurveyId(id)
    try {
      await deleteAdminSurvey(id)
      setSurveys(current => current.filter(s => s.id !== id))
      setConfirmSurveyId(null)
    } catch (err) {
      setRoleNotice({ tone: 'error', message: (err as Error).message ?? 'Failed to delete survey.' })
    } finally {
      setDeletingSurveyId(null)
    }
  }

  return (
    <div className="min-h-screen bg-base text-body p-6 animate-page-in">
      <main className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Admin</h1>
          <BackButton onClick={onBack} label="Home" />
        </div>

        {/* Deployed build info. SHA + build time are baked in at CI
            time via VITE_BUILD_SHA / VITE_BUILD_TIME. Empty strings in
            local dev builds → render a neutral 'dev' badge instead. */}
        <BuildInfo />


        {/* Stat tiles row removed — the same counts are visible
            in each tab's heading (Events (N), Users (N), Surveys
            (N)) so an always-on summary band was duplicating info,
            and the unique signals (PDF exports, WhatsApp shares,
            session-start count) were rarely the thing being
            looked at. Keeps the overview focused on the charts
            and the tab content below. */}
        {stats && (
          <>
            {/* All-time completed-tests total. A single contextual figure rather
                than a stat-tiles band (see the note above). */}
            <div className="bg-surface rounded-xl border border-line p-4">
              <p className="text-muted text-xs font-medium uppercase tracking-wider">Tests completed · all-time</p>
              <p className="text-3xl font-semibold tabular-nums mt-1">{stats.totalTestsCompleted.toLocaleString()}</p>
            </div>

            {/* Results over time chart */}
            {stats.resultsByDay.some(d => d.count > 0) && (
              <div className="bg-surface rounded-xl border border-line p-4 space-y-2">
                <p className="text-muted text-xs font-medium uppercase tracking-wider">Completed tests — last 30 days</p>
                <div className="flex items-end gap-[2px] h-16">
                  {stats.resultsByDay.map((d, i) => {
                    const max = Math.max(...stats.resultsByDay.map(x => x.count), 1)
                    const h = d.count > 0 ? Math.max(4, (d.count / max) * 64) : 0
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`${d.date}: ${d.count}`}>
                        {h > 0 && <div className="w-full bg-accent/60 rounded-sm" style={{ height: h }} />}
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between text-xs text-muted">
                  <span>{stats.resultsByDay[0]?.date.slice(5)}</span>
                  <span>{stats.resultsByDay[stats.resultsByDay.length - 1]?.date.slice(5)}</span>
                </div>
              </div>
            )}
          </>
        )}

        {/* Tab toggle */}
        <div className="flex bg-subtle-2 rounded-xl p-1 gap-1">
          {(['events', 'users', 'surveys'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                tab === t ? 'btn-primary text-white shadow-sm' : 'text-muted hover:text-ink hover:bg-surface'
              }`}
            >
              {t === 'events' ? 'Events'
                : t === 'users' ? `Users (${users.length})`
                : `Surveys (${surveys.length})`}
            </button>
          ))}
        </div>

        {loading && (
          <p className="text-muted text-center py-12">Loading...</p>
        )}

        {error && (
          <div role="alert" className="text-red-700 dark:text-red-200 text-sm bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        {/* Events tab */}
        {!loading && !error && tab === 'events' && (
          <div className="space-y-3">
          {events.length === 0 ? (
            <p className="text-muted text-center py-12">No events tracked yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm text-left">
                <thead className="bg-subtle-2 text-muted text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-3">Time</th>
                    <th className="px-3 py-3">Event</th>
                    <th className="px-3 py-3">Details</th>
                    <th className="px-3 py-3">Device</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {events.map((e, i) => (
                    <tr key={i} className="hover:bg-subtle">
                      <td className="px-3 py-2.5 text-body whitespace-nowrap">
                        {new Date(e.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        <span className="text-muted ml-1">
                          {new Date(e.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
	                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
	                          e.event === 'test_completed' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-200'
	                          : e.event === 'test_started' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200'
	                          : e.event === 'test_aborted' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-200'
	                          : e.event === 'pdf_exported' ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-200'
	                          : e.event === 'whatsapp_shared' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-200'
	                          : e.event === 'account_created' ? 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-200'
	                          : 'bg-subtle-2 text-body'
	                        }`}>
	                          {e.event.replaceAll('_', ' ')}
	                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-muted text-xs">
                        {Object.entries(e.meta).map(([k, v]) => (
                          <span key={k} className="mr-3">{k}: <span className="text-body">{v}</span></span>
                        ))}
                      </td>
                      <td className="px-3 py-2.5 text-muted font-mono text-xs">{e.deviceId.slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(events.length > 0 || cursorStack.length > 0) && (
            <div className="flex items-center justify-between text-sm pt-1">
              <button
                onClick={goToPrevEventsPage}
                disabled={cursorStack.length === 0 || eventsLoading}
                className="px-3 py-1.5 rounded-lg border border-line text-body hover:bg-subtle disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ← Newer
              </button>
              <span className="text-muted">{eventsLoading ? 'Loading…' : `Page ${cursorStack.length + 1}`}</span>
              <button
                onClick={goToNextEventsPage}
                disabled={!nextCursor || eventsLoading}
                className="px-3 py-1.5 rounded-lg border border-line text-body hover:bg-subtle disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Older →
              </button>
            </div>
          )}
          </div>
        )}

        {/* Users tab */}
        {!loading && !error && tab === 'users' && (
          users.length === 0 ? (
            <p className="text-muted text-center py-12">No users yet.</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-line bg-surface p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted">Clinician Access</p>
                <p className="mt-1 text-sm text-body">
                  Users with clinician access can import locked study profiles and see clinician/study mode controls.
                </p>
                {roleNotice && (
                  <p
                    className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                      roleNotice.tone === 'error'
                        ? 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-200'
                        : 'border-green-200 dark:border-green-900/60 bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-200'
                    }`}
                  >
                    {roleNotice.message}
                  </p>
                )}
              </div>

              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-sm text-left">
                  <thead className="bg-subtle-2 text-muted text-xs uppercase tracking-wider">
                    <tr>
                      <th className="px-3 py-3">User</th>
                      <th className="px-3 py-3">Email</th>
                      <th className="px-3 py-3">Roles</th>
                      <th className="px-3 py-3">Created</th>
                      <th className="px-3 py-3">Last login</th>
                      <th className="px-3 py-3">Logins</th>
                      <th className="px-3 py-3">Clinician Access</th>
                      <th className="px-3 py-3">Delete</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {users.map(row => {
                      const updating = roleUpdatingUserId === row.id
                      const isSelf = row.id === adminUserId
                      return (
                        <tr key={row.id} className="hover:bg-subtle">
                          <td className="px-3 py-2.5">
                            <div className="text-ink">{row.displayName}</div>
                            <div className="font-mono text-xs text-muted">{row.id.slice(0, 8)}</div>
                          </td>
                          <td className="px-3 py-2.5 text-muted">{row.email}</td>
                          <td className="px-3 py-2.5">
                            <RoleBadges isAdmin={row.isAdmin} isClinician={row.isClinician} />
                          </td>
                          <td className="px-3 py-2.5 text-muted whitespace-nowrap">
                            {new Date(row.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </td>
                          <td className="px-3 py-2.5 text-muted whitespace-nowrap">
                            {row.lastLoginAt
                              ? new Date(row.lastLoginAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                              : <span className="text-muted">Never</span>}
                          </td>
                          <td className="px-3 py-2.5 text-muted tabular-nums">{row.totalLogins}</td>
                          <td className="px-3 py-2.5">
                            <button
                              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                row.isClinician
                                  ? 'border-teal-300 bg-teal-50 text-teal-700 hover:bg-teal-100'
                                  : 'border-line bg-surface text-body hover:border-line-strong hover:text-ink'
                              }`}
                              disabled={updating}
                              onClick={() => void setClinicianRoleForUser(row, !row.isClinician)}
                            >
                              {updating ? 'Updating...' : row.isClinician ? 'Clinician enabled' : 'Grant clinician'}
                            </button>
                          </td>
                          <td className="px-3 py-2.5">
                            <button
                              className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-200 transition-colors hover:bg-red-100 hover:text-red-800 dark:hover:bg-red-900/40 dark:hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
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
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-user-title"
            onClick={() => { if (!deletingUserId) { setDeleteTarget(null); setDeleteTyped('') } }}
          >
            <div
              className="w-full max-w-md rounded-2xl border border-red-200 dark:border-red-800 bg-surface p-6 shadow-xl"
              onClick={e => e.stopPropagation()}
            >
              <h2 id="delete-user-title" className="text-lg font-semibold text-ink">Delete user</h2>
              <p className="mt-3 text-sm text-body">
                This will permanently delete <span className="font-semibold text-ink">{deleteTarget.displayName}</span> ({deleteTarget.email}) and all their sessions, test results, surveys, participants, and saved screens. This cannot be undone.
              </p>
              <p className="mt-4 text-xs text-muted">
                Type the user's name (<span className="font-mono text-ink">{deleteTarget.displayName}</span>) to confirm:
              </p>
              <input
                type="text"
                autoFocus
                value={deleteTyped}
                onChange={e => setDeleteTyped(e.target.value)}
                className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-red-400 focus:outline-none"
                placeholder={deleteTarget.displayName}
                disabled={deletingUserId === deleteTarget.id}
              />
              <div className="mt-5 flex justify-end gap-2">
                <button
                  className="rounded-lg border border-line bg-surface px-4 py-2 text-sm text-body hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={deletingUserId === deleteTarget.id}
                  onClick={() => { setDeleteTarget(null); setDeleteTyped('') }}
                >
                  Cancel
                </button>
                <button
                  className="rounded-lg border border-red-600 bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={deleteTyped.trim() !== deleteTarget.displayName || deletingUserId === deleteTarget.id}
                  onClick={() => void confirmDeleteUser()}
                >
                  {deletingUserId === deleteTarget.id ? 'Deleting…' : 'Delete user'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Surveys tab */}
        {!loading && !error && tab === 'surveys' && (
          surveys.length === 0 ? (
            <p className="text-muted text-center py-12">No survey responses yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm text-left">
                <thead className="bg-subtle-2 text-muted text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-3">Date</th>
                    <th className="px-3 py-3">Accuracy</th>
                    <th className="px-3 py-3">Ease</th>
                    <th className="px-3 py-3">Clarity</th>
                    <th className="px-3 py-3 min-w-[200px]">Feedback</th>
                    <th className="px-3 py-3">Device</th>
                    <th className="px-3 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {surveys.map(s => (
                    <tr key={s.id} className="hover:bg-subtle">
                      <td className="px-3 py-2.5 text-body whitespace-nowrap">
                        {new Date(s.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {s.perceivedAccuracy != null ? ratingBadge(s.perceivedAccuracy) : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {s.easeOfUse != null ? ratingBadge(s.easeOfUse) : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {s.instructionsClarity != null ? ratingBadge(s.instructionsClarity) : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-body max-w-xs">
                        {s.freeformFeedback ? (
                          <span className="line-clamp-2">{s.freeformFeedback}</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted font-mono text-xs">{s.deviceId.slice(0, 8)}</td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {confirmSurveyId === s.id ? (
                          <span className="inline-flex items-center gap-2">
                            <button
                              onClick={() => confirmDeleteSurvey(s.id)}
                              disabled={deletingSurveyId === s.id}
                              className="text-xs font-medium text-red-600 dark:text-red-400 hover:text-red-700 disabled:opacity-50"
                            >
                              {deletingSurveyId === s.id ? 'Deleting…' : 'Confirm'}
                            </button>
                            <button
                              onClick={() => setConfirmSurveyId(null)}
                              disabled={deletingSurveyId === s.id}
                              className="text-xs text-muted hover:text-ink disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmSurveyId(s.id)}
                            className="text-xs text-muted hover:text-red-600"
                            aria-label="Delete survey"
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </main>
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
    <div className="rounded-xl border border-line bg-surface px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted">Deployed build</span>
        {commitHref ? (
          <a
            href={commitHref}
            target="_blank"
            rel="noopener"
            className="font-mono text-accent hover:text-accent-dark underline decoration-dotted"
          >
            {shortSha}
          </a>
        ) : (
          <span className="font-mono text-body">{shortSha}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted">Built</span>
        <span className="text-body">{builtAt}</span>
      </div>
    </div>
  )
}

function RoleBadges({ isAdmin, isClinician }: { isAdmin: boolean; isClinician: boolean }) {
  if (!isAdmin && !isClinician) {
    return <span className="text-xs text-muted">User</span>
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
    value >= 4 ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-200'
    : value === 3 ? 'bg-subtle-2 text-body'
    : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-200'
  return (
    <span className={`inline-block w-7 text-center py-0.5 rounded text-xs font-medium ${color}`}>
      {value}
    </span>
  )
}
