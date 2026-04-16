import { useState, useEffect, useRef } from 'react'
import type { TestResult } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { getResults, deleteResult, saveResult } from '../storage'
import { VisualFieldMap } from './VisualFieldMap'
import { Interpretation } from './Interpretation'
import { VisionSimulator } from './VisionSimulator'
import { exportResultPDF } from '../pdfExport'
import { downloadOvfx, parseOvfxFile, OvfxImportError } from '../ovfx'
import { useAuth } from '../AuthContext'
import { formatEyeLabel } from '../eyeLabels'
import * as api from '../api'
import { BackButton } from './AccessibleNav'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'
import { ScenarioOverlay } from './ScenarioOverlay'

/** Shape markers for each isopter so color isn't the only differentiator */
const ISOPTER_SHAPES: Record<string, string> = {
  'V4e': '●',   // filled circle
  'III4e': '■',  // filled square
  'III2e': '▲',  // filled triangle
  'I4e': '◆',   // filled diamond
  'I2e': '★',   // star
}

interface Props {
  onBack: () => void
}

export function HistoryView({ onBack }: Props) {
  const [results, setResults] = useState<TestResult[]>(() =>
    getResults().sort((a, b) => b.date.localeCompare(a.date))
  )
  const [selected, setSelected] = useState<TestResult | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [syncedIds, setSyncedIds] = useState<Set<string>>(new Set())
  const [importMessage, setImportMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [showOvfxHelp, setShowOvfxHelp] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)
  const { user } = useAuth()

  const handleImport = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    let imported = 0
    const errors: string[] = []
    for (const file of Array.from(files)) {
      try {
        const result = await parseOvfxFile(file)
        saveResult(result)
        imported++
      } catch (err) {
        const msg = err instanceof OvfxImportError ? err.message : (err as Error).message
        errors.push(`${file.name}: ${msg}`)
      }
    }
    setResults(getResults().sort((a, b) => b.date.localeCompare(a.date)))
    if (errors.length === 0) {
      setImportMessage({ kind: 'ok', text: `Imported ${imported} OVFX file${imported === 1 ? '' : 's'}.` })
    } else if (imported === 0) {
      setImportMessage({ kind: 'error', text: errors.join(' • ') })
    } else {
      setImportMessage({
        kind: 'error',
        text: `Imported ${imported}, failed ${errors.length}: ${errors.join(' • ')}`,
      })
    }
    // Auto-clear the message after 6s
    setTimeout(() => setImportMessage(null), 6000)
  }

  // Fetch synced result IDs from server
  useEffect(() => {
    if (!user) return
    api.listVFResults()
      .then(res => setSyncedIds(new Set(res.results.map(r => r.id))))
      .catch(() => {})
  }, [user])

  const handleDelete = (id: string) => {
    deleteResult(id)
    setResults(prev => prev.filter(r => r.id !== id))
    if (selected?.id === id) setSelected(null)
    setConfirmDeleteId(null)
    // Also delete from server if logged in
    if (user) api.deleteVFResult(id).catch(() => {})
  }

  // Group results by binocularGroup so a paired binocular session shows up as
  // a single "Both eyes" entry even though it's stored as two rows.
  const binocularGroups: { groupId: string; right?: TestResult; left?: TestResult; date: string }[] = (() => {
    const byGroup = new Map<string, { right?: TestResult; left?: TestResult; date: string }>()
    for (const r of results) {
      if (!r.binocularGroup) continue
      const slot = byGroup.get(r.binocularGroup) ?? { date: r.date }
      if (r.eye === 'right') slot.right = r
      else if (r.eye === 'left') slot.left = r
      // Keep the earlier date for display stability
      if (r.date < slot.date) slot.date = r.date
      byGroup.set(r.binocularGroup, slot)
    }
    return [...byGroup.entries()]
      .map(([groupId, slot]) => ({ groupId, ...slot }))
      .filter(g => g.right && g.left)
      .sort((a, b) => b.date.localeCompare(a.date))
  })()
  const pairedIds = new Set(
    binocularGroups.flatMap(g => [g.right?.id, g.left?.id].filter((x): x is string => !!x)),
  )
  // Single-eye buckets only include results that aren't part of a paired
  // binocular session.
  const rightEyeResults = results.filter(r => r.eye === 'right' && !pairedIds.has(r.id))
  const leftEyeResults = results.filter(r => r.eye === 'left' && !pairedIds.has(r.id))

  if (selected) {
    // Filter out extended-field points for radar/areas/interpretation
    const maxEcc = selected.calibration.maxEccentricityDeg
    const standardPoints = selected.points.filter(p => p.eccentricityDeg <= maxEcc + 2)
    const standardAreas: Partial<Record<string, number>> = {}
    for (const key of ISOPTER_ORDER) {
      const pts = standardPoints.filter(p => p.stimulus === key && p.detected)
      if (pts.length >= 3) {
        const allPts = selected.points.filter(p => p.stimulus === key && p.detected)
        const hasExtended = allPts.some(p => p.eccentricityDeg > maxEcc + 2)
        standardAreas[key] = hasExtended ? selected.isopterAreas[key] : selected.isopterAreas[key]
      } else if (selected.isopterAreas[key] != null) {
        standardAreas[key] = selected.isopterAreas[key]
      }
    }
    return (
      <div className="min-h-[100dvh] bg-base text-white safe-pad p-6 animate-page-in">
        <main className="max-w-lg mx-auto space-y-6">
          <BackButton onClick={() => setSelected(null)} label="Back to results" />
          <h1 className="text-xl font-heading font-bold">
            {selected.eye === 'right' ? <><abbr title="Oculus Dexter">OD</abbr> (Right)</> : <><abbr title="Oculus Sinister">OS</abbr> (Left)</>} —{' '}
            {new Date(selected.date).toLocaleDateString()}
            {selected.binocularGroup && (
              <span className="ml-2 text-xs font-normal text-teal/80">· part of a binocular session</span>
            )}
          </h1>
          <p className="text-zinc-400 text-sm">
            {new Date(selected.date).toLocaleTimeString()}
            {selected.testType && (
              <span className="ml-2 text-zinc-500">· {selected.testType === 'ring' ? 'Ring test' : selected.testType === 'static' ? 'Static test' : 'Goldmann'}</span>
            )}
          </p>
          <VisualFieldMap
            points={standardPoints}
            eye={selected.eye}
            maxEccentricity={maxEcc}
            calibration={selected.calibration}
            enableVerify
          />
          <div className="grid grid-cols-2 gap-2 text-sm">
            {ISOPTER_ORDER.map(key => {
              const area = selected.isopterAreas[key]
              if (area == null) return null
              return (
                <div key={key} className="bg-surface rounded-xl px-3 py-2 flex items-center gap-2 border border-white/[0.06]">
                  <span className="w-4 text-center" style={{ color: STIMULI[key].color }} aria-hidden="true">{ISOPTER_SHAPES[key] || '●'}</span>
                  <span className="text-zinc-400">{STIMULI[key].label}</span>
                  <span className="ml-auto font-mono">{area.toFixed(0)} deg²</span>
                </div>
              )
            })}
          </div>
          <Interpretation points={standardPoints} areas={selected.isopterAreas} maxEccentricityDeg={selected.calibration.maxEccentricityDeg} calibration={selected.calibration} />
          <ScenarioOverlay userPoints={standardPoints} userAreas={selected.isopterAreas} maxEccentricity={maxEcc} />
          {/* Vision sim gets ALL points including extended for wider coverage */}
          <VisionSimulator
            points={selected.points}
            eye={selected.eye}
            maxEccentricity={maxEcc}
          />
          <div className="text-sm text-zinc-500 space-y-1">
            <p>Viewing distance: {selected.calibration.viewingDistanceCm} cm</p>
            <p>Max eccentricity: {selected.calibration.maxEccentricityDeg}°</p>
            <p>Total points: {selected.points.length} ({selected.points.filter(p => p.detected).length} detected)</p>
          </div>
          <ClinicalDisclaimer variant="results" />
          <div className="flex gap-3">
            <button
              onClick={() => exportResultPDF(selected)}
              className="flex-1 py-2.5 btn-primary rounded-xl text-sm font-medium text-white"
            >
              Export PDF
            </button>
            <button
              onClick={() => downloadOvfx(selected)}
              title="Open Visual Field eXchange — portable JSON for other tools"
              className="flex-1 py-2.5 bg-surface hover:bg-elevated rounded-xl text-sm font-medium text-zinc-200 transition-colors border border-white/[0.06]"
            >
              Export OVFX
            </button>
            <button
              onClick={() => setConfirmDeleteId(selected.id)}
              className="py-2.5 px-4 bg-surface hover:bg-elevated rounded-xl text-sm text-red-400 hover:text-red-300 transition-colors border border-white/[0.06]"
            >
              Delete
            </button>
          </div>

          {/* Delete confirmation dialog */}
          {confirmDeleteId && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation">
              <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-confirm-title"
                aria-describedby="delete-confirm-desc"
                className="bg-surface border border-white/[0.08] rounded-2xl p-6 w-full max-w-xs space-y-4 shadow-2xl animate-page-in"
              >
                <h2 id="delete-confirm-title" className="text-lg font-heading font-bold text-white">Delete result?</h2>
                <p id="delete-confirm-desc" className="text-zinc-400 text-sm">
                  This will permanently remove this test result. This action cannot be undone.
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="flex-1 py-2.5 bg-elevated hover:bg-overlay rounded-xl text-sm font-medium transition-colors"
                    autoFocus
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleDelete(confirmDeleteId)}
                    className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 rounded-xl text-sm font-medium transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-[100dvh] bg-base text-white safe-pad p-6 animate-page-in">
      <main className="max-w-2xl mx-auto space-y-8">
        <div className="flex items-center justify-between pb-5 border-b border-white/[0.06]">
          <h1 className="text-3xl font-heading font-bold">Results</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => importInputRef.current?.click()}
              title="Import one or more OVFX (.ovfx.json) files"
              className="text-xs font-medium text-zinc-300 hover:text-white bg-surface hover:bg-elevated border border-white/[0.06] rounded-lg min-h-[44px] px-3"
            >
              Import OVFX
            </button>
            <button
              onClick={() => setShowOvfxHelp(v => !v)}
              aria-expanded={showOvfxHelp}
              aria-label="What is OVFX?"
              title="What is OVFX?"
              className="text-zinc-400 hover:text-white bg-surface hover:bg-elevated border border-white/[0.06] rounded-lg min-h-[44px] w-10 flex items-center justify-center"
            >
              ?
            </button>
            <BackButton onClick={onBack} label="Home" />
          </div>
        </div>

        <input
          ref={importInputRef}
          type="file"
          accept=".json,.ovfx.json,application/json"
          multiple
          className="hidden"
          onChange={e => { handleImport(e.target.files); e.target.value = '' }}
        />

        {showOvfxHelp && (
          <div className="bg-surface border border-white/[0.08] rounded-2xl p-5 space-y-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-heading font-bold text-white">About OVFX files</h3>
              <button
                onClick={() => setShowOvfxHelp(false)}
                aria-label="Close help"
                className="text-zinc-500 hover:text-white text-lg leading-none -mt-1"
              >×</button>
            </div>
            <p className="text-zinc-300 leading-relaxed">
              <strong className="text-white">OVFX</strong> (Open Visual Field eXchange) is a small, open
              JSON format for visual-field perimetry results. Think of it as a portable way to move a test
              result between apps — like <em>CSV for spreadsheets</em>, but for a perimetry session.
            </p>
            <div className="space-y-1.5 text-zinc-300">
              <p>
                <span className="text-white font-medium">Export</span> — on any result detail page, click{' '}
                <span className="inline-block px-1.5 py-0.5 bg-elevated rounded text-[11px] font-mono">Export OVFX</span>.
                A single <code>.ovfx.json</code> file downloads with every recorded point, the test-time
                calibration, and the metadata needed to reproduce the result elsewhere.
              </p>
              <p>
                <span className="text-white font-medium">Import</span> — click{' '}
                <span className="inline-block px-1.5 py-0.5 bg-elevated rounded text-[11px] font-mono">Import OVFX</span>{' '}
                and pick one or more <code>.ovfx.json</code> files. Binocular sessions exported as two
                files (one per eye) are automatically re-linked by their shared session ID.
              </p>
              <p>
                <span className="text-white font-medium">No personal data</span> — exported files contain
                only the test result itself. No name, no date of birth, no identifiers unless you opt in.
              </p>
            </div>
            <p className="text-xs text-zinc-500">
              The full specification lives at{' '}
              <a
                href="https://github.com/openperimetry/ovfx-spec"
                target="_blank"
                rel="noopener"
                className="text-accent hover:text-accent-light underline"
              >
                github.com/openperimetry/ovfx-spec
              </a>.
            </p>
          </div>
        )}

        {importMessage && (
          <div
            role="status"
            className={`rounded-xl border px-4 py-3 text-sm ${
              importMessage.kind === 'ok'
                ? 'bg-teal/10 border-teal/30 text-teal'
                : 'bg-red-500/10 border-red-500/30 text-red-300'
            }`}
          >
            {importMessage.text}
          </div>
        )}

        {!user && results.length > 0 && (
          <div className="flex items-start gap-3 bg-amber-500/8 border border-amber-500/15 rounded-2xl px-4 py-3" role="status">
            <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <div>
              <p className="text-amber-300 text-sm font-medium">Results stored locally only</p>
              <p className="text-amber-400/60 text-xs mt-0.5">
                These results are saved in your browser cache and will be lost if you clear your browser data.
                Sign in to sync results to the cloud.
              </p>
            </div>
          </div>
        )}

        {results.length === 0 && (
          <div className="rounded-2xl border border-white/[0.06] bg-surface/40 px-6 py-12 text-center space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-accent/8 flex items-center justify-center border border-accent/15" aria-hidden="true">
              <svg viewBox="0 0 48 48" className="w-8 h-8 text-accent/80" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <circle cx="24" cy="24" r="20" strokeOpacity="0.4" />
                <circle cx="24" cy="24" r="13" strokeOpacity="0.6" />
                <circle cx="24" cy="24" r="6" strokeOpacity="0.85" />
                <circle cx="24" cy="24" r="1.5" fill="currentColor" stroke="none" />
              </svg>
            </div>
            <div className="space-y-1">
              <p className="text-white font-heading font-semibold">No results yet</p>
              <p className="text-zinc-500 text-sm max-w-sm mx-auto">
                Run your first test from the home screen. Results are saved automatically so you can track changes over time.
              </p>
            </div>
            <button
              onClick={onBack}
              className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent-light transition-colors min-h-[44px] px-3"
            >
              Go to home
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}

        {results.length >= 2 && <AreaChart results={results} />}

        {/* Binocular combined view — uses latest result from each eye */}
        {rightEyeResults.length > 0 && leftEyeResults.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-lg font-heading font-semibold text-zinc-200">Combined binocular vision</h2>
            <p className="text-xs text-zinc-500">
              Simulates what you see with both eyes open — visible if either eye can see the area.
            </p>
            <VisionSimulator
              points={rightEyeResults[0].points}
              eye="right"
              maxEccentricity={rightEyeResults[0].calibration.maxEccentricityDeg}
              secondEyePoints={leftEyeResults[0].points}
              secondEyeMaxEccentricity={leftEyeResults[0].calibration.maxEccentricityDeg}
            />
          </div>
        )}

        {(binocularGroups.length > 0 || rightEyeResults.length > 0 || leftEyeResults.length > 0) && (
          <ResultsList
            binocularGroups={binocularGroups}
            singleResults={[...rightEyeResults, ...leftEyeResults]}
            onSelect={setSelected}
            onExportPDF={entry => {
              if (entry.kind === 'single') {
                exportResultPDF(entry.result)
                return
              }
              // Binocular pair — render as combined OU report.
              const anchor = entry.right ?? entry.left
              if (!anchor) return
              const rightPoints = entry.right?.points ?? []
              const leftPoints = entry.left?.points ?? []
              const combined = [...rightPoints, ...leftPoints]
              exportResultPDF(
                { ...anchor, points: combined },
                { binocular: true, rightEyePoints: rightPoints, leftEyePoints: leftPoints },
              )
            }}
            onExportOvfx={entry => {
              if (entry.kind === 'single') {
                downloadOvfx(entry.result)
                return
              }
              // Binocular pair → two OVFX files sharing the same
              // binocularGroup. Emit them back-to-back; browsers allow
              // multiple downloads from a single user gesture.
              if (entry.right) downloadOvfx(entry.right)
              if (entry.left) downloadOvfx(entry.left)
            }}
            syncedIds={syncedIds}
            showSync={!!user}
          />
        )}
      </main>
    </div>
  )
}

type ListEntry =
  | { kind: 'single'; result: TestResult; date: string }
  | { kind: 'pair'; groupId: string; right?: TestResult; left?: TestResult; date: string }

function testTypeBadge(t?: string) {
  if (!t) return null
  const cls = t === 'ring' ? 'bg-purple-600/15 text-purple-400' : t === 'static' ? 'bg-teal/10 text-teal' : 'bg-accent/10 text-accent'
  const label = t === 'ring' ? 'Ring' : t === 'static' ? 'Static' : 'Goldmann'
  return <span className={`text-xs ml-2 px-1.5 py-0.5 rounded ${cls}`}>{label}</span>
}

/** Small teal check (synced) or amber warning (local-only) indicator. */
function SyncIndicator({ synced }: { synced: boolean }) {
  return synced ? (
    <svg className="w-3 h-3 text-teal shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-label="Synced to cloud">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
    </svg>
  ) : (
    <svg className="w-3 h-3 text-amber-500 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-label="Local only (not synced)">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
    </svg>
  )
}

function ResultsList({
  binocularGroups,
  singleResults,
  onSelect,
  onExportPDF,
  onExportOvfx,
  syncedIds,
  showSync,
}: {
  binocularGroups: { groupId: string; right?: TestResult; left?: TestResult; date: string }[]
  singleResults: TestResult[]
  onSelect: (r: TestResult) => void
  onExportPDF: (entry: ListEntry) => void
  onExportOvfx: (entry: ListEntry) => void
  syncedIds: Set<string>
  showSync: boolean
}) {
  // Merge into a single chronological list. Binocular pairs are one entry with
  // two sub-buttons; single-eye results are one entry with one button.
  const entries: ListEntry[] = [
    ...binocularGroups.map<ListEntry>(g => ({ kind: 'pair' as const, groupId: g.groupId, right: g.right, left: g.left, date: g.date })),
    ...singleResults.map<ListEntry>(r => ({ kind: 'single' as const, result: r, date: r.date })),
  ].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <section className="space-y-3" aria-label="Results list">
      <h2 className="text-lg font-heading font-semibold text-zinc-200">
        All results
        <span className="ml-2 text-sm font-normal text-zinc-500">({entries.length})</span>
      </h2>
      <div className="space-y-2">
        {entries.map((entry, i) => {
          const testType = entry.kind === 'single' ? entry.result.testType : (entry.right?.testType ?? entry.left?.testType)
          const dateLabel = new Date(entry.date).toLocaleDateString()
          const timeLabel = new Date(entry.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

          // Resolve the two slots up front so every card has the same layout:
          // OS on the left, OD on the right. Pairs fill both; single-eye
          // entries fill only their side and leave the other as a placeholder.
          const leftResult = entry.kind === 'single'
            ? (entry.result.eye === 'left' ? entry.result : undefined)
            : entry.left
          const rightResult = entry.kind === 'single'
            ? (entry.result.eye === 'right' ? entry.result : undefined)
            : entry.right
          const eyeBadgeCls = entry.kind === 'single'
            ? 'bg-accent/10 text-accent'
            : 'bg-accent/10 text-accent'
          const eyeBadgeLabel: 'OD' | 'OS' | 'OU' = entry.kind === 'single'
            ? formatEyeLabel(entry.result.eye)
            : 'OU'
          const keyId = entry.kind === 'single' ? `single-${entry.result.id}` : `pair-${entry.groupId || i}`
          const anyR = entry.kind === 'single' ? entry.result : (entry.right ?? entry.left)

          return (
            <div
              key={keyId}
              className="px-4 py-3 bg-surface rounded-2xl border border-white/[0.06] space-y-2"
            >
              <div className="flex items-center text-sm">
                <span className="text-white">{dateLabel}</span>
                <span className="text-zinc-500 ml-3">{timeLabel}</span>
                <span className={`text-xs ml-2 px-1.5 py-0.5 rounded ${eyeBadgeCls}`}>
                  {eyeBadgeLabel === 'OU' ? <abbr title="Oculus Uterque">OU</abbr> : eyeBadgeLabel}
                </span>
                {testTypeBadge(testType)}
                {entry.kind === 'single' && anyR && (
                  <span className="text-zinc-500 text-xs ml-2">{anyR.points.length} pts</span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={e => { e.stopPropagation(); onExportPDF(entry) }}
                    aria-label="Export as PDF"
                    title="Export as PDF"
                    className="w-7 h-7 flex items-center justify-center rounded text-zinc-500 hover:text-white hover:bg-white/[0.06] transition-colors"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
                      <path d="M14 3v5h5" />
                      <path d="M9 13h6M9 17h4" />
                    </svg>
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); onExportOvfx(entry) }}
                    aria-label="Export as OVFX"
                    title="Export as OVFX (portable JSON)"
                    className="w-7 h-7 flex items-center justify-center rounded text-zinc-500 hover:text-white hover:bg-white/[0.06] transition-colors"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                      <path d="M12 3v12" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M5 21h14" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                {leftResult ? (
                  <button
                    onClick={() => onSelect(leftResult)}
                    className="flex-1 px-3 py-2 bg-elevated hover:bg-overlay rounded-xl text-xs text-left transition-colors border border-white/[0.04] flex items-center gap-2"
                  >
                    {showSync && <SyncIndicator synced={syncedIds.has(leftResult.id)} />}
                    <span className="text-zinc-300 font-medium">OS (Left)</span>
                    {leftResult.isopterAreas['III4e'] != null && (
                      <span className="ml-auto font-mono text-teal">
                        {leftResult.isopterAreas['III4e']!.toFixed(0)} deg²
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="flex-1 px-3 py-2 rounded-xl text-xs text-zinc-600 text-left border border-dashed border-white/[0.04]">
                    OS (Left) — not tested
                  </div>
                )}
                {rightResult ? (
                  <button
                    onClick={() => onSelect(rightResult)}
                    className="flex-1 px-3 py-2 bg-elevated hover:bg-overlay rounded-xl text-xs text-left transition-colors border border-white/[0.04] flex items-center gap-2"
                  >
                    {showSync && <SyncIndicator synced={syncedIds.has(rightResult.id)} />}
                    <span className="text-zinc-300 font-medium">OD (Right)</span>
                    {rightResult.isopterAreas['III4e'] != null && (
                      <span className="ml-auto font-mono text-teal">
                        {rightResult.isopterAreas['III4e']!.toFixed(0)} deg²
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="flex-1 px-3 py-2 rounded-xl text-xs text-zinc-600 text-left border border-dashed border-white/[0.04]">
                    OD (Right) — not tested
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function AreaChart({ results }: { results: TestResult[] }) {
  const sorted = [...results].sort((a, b) => a.date.localeCompare(b.date))
  // Show III4e area trend (the clinically standard isopter)
  const dataPoints = sorted
    .map(r => ({ date: r.date, area: r.isopterAreas['III4e'] ?? null }))
    .filter((d): d is { date: string; area: number } => d.area !== null)

  if (dataPoints.length < 2) return null

  const areas = dataPoints.map(d => d.area)
  const maxArea = Math.max(...areas, 1)
  const w = 600
  const h = 160
  const px = 40
  const py = 20

  const points = dataPoints.map((d, i) => {
    const x = px + ((w - px - 20) * i) / Math.max(dataPoints.length - 1, 1)
    const y = py + (h - 2 * py) * (1 - d.area / maxArea)
    return { x, y, date: d.date }
  })

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

  return (
    <div className="space-y-2">
      <h2 className="text-sm text-zinc-400 font-heading font-semibold">III4e isopter area over time</h2>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxWidth: w }} role="img" aria-label="Chart showing III4e isopter area trend over time">
        <text x={px - 4} y={py + 4} fill="#71717a" fontSize={10} textAnchor="end">
          {maxArea.toFixed(0)}
        </text>
        <text x={px - 4} y={h - py + 4} fill="#71717a" fontSize={10} textAnchor="end">
          0
        </text>
        <line x1={px} y1={py} x2={px} y2={h - py} stroke="#27272a" strokeWidth={0.5} />
        <line x1={px} y1={h - py} x2={w - 20} y2={h - py} stroke="#27272a" strokeWidth={0.5} />
        <path d={linePath} fill="none" stroke="#2dd4bf" strokeWidth={2} />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={4} fill="#2dd4bf" />
            {(i === 0 || i === points.length - 1) && (
              <text x={p.x} y={h - 2} fill="#71717a" fontSize={9} textAnchor="middle">
                {new Date(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}
