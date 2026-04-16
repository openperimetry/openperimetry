import { useState, useEffect } from 'react'
import { getAdminStats, getAdminSessions, getAdminVFResults, getAdminSurveys, getAdminEvents, type AdminStats, type AdminSessionRecord, type AdminVFResultRecord, type AdminSurveyRecord, type AdminEventRecord } from '../api'
import { BackButton } from './AccessibleNav'
import { formatEyeLabelForResult } from '../eyeLabels'

interface Props {
  onBack: () => void
}

type Tab = 'events' | 'sessions' | 'results' | 'surveys'

const CLINICAL_LABELS: Record<string, string> = {
  never_had_clinical: 'Never had clinical test',
  more_sensitive: 'This detects more',
  similar: 'Similar results',
  less_sensitive: 'Clinical detects more',
}

const RP_TYPE_LABELS: Record<string, string> = {
  autosomal_dominant: 'AD',
  autosomal_recessive: 'AR',
  x_linked: 'X-linked',
  usher: 'Usher',
  unknown: 'Unknown',
  other: 'Other',
}

const AID_LABELS: Record<string, string> = {
  none: 'None',
  glasses: 'Glasses',
  cane: 'Cane',
  guide_dog: 'Guide dog',
  multiple: 'Multiple',
}

const FIELD_TEST_LABELS: Record<string, string> = {
  never: 'Never',
  within_year: '<1 yr',
  '1_3_years': '1-3 yr',
  over_3_years: '>3 yr',
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
  const [tab, setTab] = useState<Tab>('events')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [events, setEvents] = useState<AdminEventRecord[]>([])
  const [sessions, setSessions] = useState<AdminSessionRecord[]>([])
  const [vfResults, setVfResults] = useState<AdminVFResultRecord[]>([])
  const [surveys, setSurveys] = useState<AdminSurveyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const pdfExportCount = events.filter(e => e.event === 'pdf_exported').length
  const whatsappShareCount = events.filter(e => e.event === 'whatsapp_shared').length

  useEffect(() => {
    Promise.all([getAdminStats(), getAdminEvents(), getAdminSessions(), getAdminVFResults(), getAdminSurveys()])
      .then(([statsRes, eventsRes, sessionsRes, resultsRes, surveysRes]) => {
        setStats(statsRes)
        setEvents(eventsRes.events)
        setSessions(sessionsRes.sessions)
        setVfResults(resultsRes.results)
        setSurveys(surveysRes.surveys)
      })
      .catch(err => setError(err.message ?? 'Failed to load admin data'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-screen bg-page text-white p-6 animate-page-in">
      <main className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Admin</h1>
          <BackButton onClick={onBack} label="Home" />
        </div>

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
                <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">VF results — last 30 days</p>
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
          {(['events', 'sessions', 'results', 'surveys'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                tab === t ? 'btn-primary text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-gray-800/80'
              }`}
            >
              {t === 'events' ? `Events (${events.length})`
                : t === 'sessions' ? `Sessions (${sessions.length})`
                : t === 'results' ? `VF Results (${vfResults.length})`
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

        {/* Sessions tab */}
        {!loading && !error && tab === 'sessions' && (
          sessions.length === 0 ? (
            <p className="text-gray-500 text-center py-12">No active sessions.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-800/60">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-900/80 text-gray-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-3">User</th>
                    <th className="px-3 py-3">Email</th>
                    <th className="px-3 py-3">Last active</th>
                    <th className="px-3 py-3">Created</th>
                    <th className="px-3 py-3">Expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/30">
                  {sessions.map((s, i) => {
                    const isExpired = new Date(s.expiresAt) < new Date()
                    return (
                      <tr key={`${s.userId}-${i}`} className={`hover:bg-gray-900/40 ${isExpired ? 'opacity-40' : ''}`}>
                        <td className="px-3 py-2.5 text-gray-300">{s.displayName}</td>
                        <td className="px-3 py-2.5 text-gray-400">{s.email}</td>
                        <td className="px-3 py-2.5 text-gray-300 whitespace-nowrap">
                          {new Date(s.lastSeenAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          <span className="text-gray-600 ml-1">
                            {new Date(s.lastSeenAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">
                          {new Date(s.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className={isExpired ? 'text-red-400/60 text-xs' : 'text-gray-500 text-xs'}>
                            {isExpired ? 'Expired' : new Date(s.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* VF Results tab */}
        {!loading && !error && tab === 'results' && (
          vfResults.length === 0 ? (
            <p className="text-gray-500 text-center py-12">No VF results synced yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-800/60">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-900/80 text-gray-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-3">Date</th>
                    <th className="px-3 py-3">Eye</th>
	                    <th className="px-3 py-3">Test Type</th>
	                    <th className="px-3 py-3">Points</th>
	                    <th className="px-3 py-3">Duration</th>
	                    <th className="px-3 py-3">User ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/30">
                  {vfResults.map(r => (
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
	                      <td className="px-3 py-2.5 text-gray-600 font-mono text-xs">{r.userId.slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                    <th className="px-3 py-3">vs Clinical</th>
                    <th className="px-3 py-3 min-w-[200px]">Feedback</th>
                    <th className="px-3 py-3">Age</th>
                    <th className="px-3 py-3">Yrs Dx</th>
                    <th className="px-3 py-3">RP Type</th>
                    <th className="px-3 py-3">Aid</th>
                    <th className="px-3 py-3">Last VF</th>
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
                      <td className="px-3 py-2.5 text-gray-400">{labelOf(CLINICAL_LABELS, s.comparedToClinical)}</td>
                      <td className="px-3 py-2.5 text-gray-300 max-w-xs">
                        {s.freeformFeedback ? (
                          <span className="line-clamp-2">{s.freeformFeedback}</span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-gray-400 text-center">{s.age ?? '—'}</td>
                      <td className="px-3 py-2.5 text-gray-400 text-center">{s.yearsDiagnosed ?? '—'}</td>
                      <td className="px-3 py-2.5 text-gray-400">{labelOf(RP_TYPE_LABELS, s.rpType)}</td>
                      <td className="px-3 py-2.5 text-gray-400">{labelOf(AID_LABELS, s.currentAid)}</td>
                      <td className="px-3 py-2.5 text-gray-400">{labelOf(FIELD_TEST_LABELS, s.clinicalFieldTest)}</td>
                      <td className="px-3 py-2.5 text-gray-600 font-mono text-xs">{s.deviceId.slice(0, 8)}</td>
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

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="bg-gray-900/70 rounded-xl p-4 border border-gray-800/60">
      <p className="text-gray-500 text-xs uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-semibold text-white">{value}</p>
      {sub && <p className="text-gray-600 text-xs mt-0.5">{sub}</p>}
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
