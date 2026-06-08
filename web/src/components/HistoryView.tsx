import { useState, useEffect, useRef } from 'react'
import type { TestResult } from '../types'
import { STIMULI, ISOPTER_ORDER, isGoldmannResult } from '../types'
import { getResults, deleteResult, removeTombstone, saveResult, saveSurvey, hasSurveyForResult } from '../storage'
import { VisualFieldMap } from './VisualFieldMap'
import { HFAResultsView } from './HFAResultsView'
import type { StaticGridPattern } from '../grids'
import { Interpretation } from './Interpretation'
import { exportTrackedResultPDF } from '../pdfExportTracking'
import { downloadOvfx, parseOvfxFile, OvfxImportError } from '../ovfx'
import { useAuth } from '../AuthContext'
import { formatEyeLabel } from '../eyeLabels'
import * as api from '../api'
import { BackButton } from './AccessibleNav'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'
import { ScenarioOverlay } from './ScenarioOverlay'
import { PostTestSurvey } from './PostTestSurvey'
import type { SurveyResponse } from './PostTestSurvey'

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

function describeProtocol(result: TestResult): string[] {
  const protocol = result.protocol
  if (!protocol) return []
  const out: string[] = []
  if (protocol.label) out.push(`${protocol.label}${protocol.version ? ` (v${protocol.version})` : ''}`)
  out.push(protocol.testType === 'static' ? 'Static' : 'Goldmann')
  if (protocol.testMode) out.push(protocol.testMode)
  if (protocol.speedMode) {
    out.push(
      protocol.speedMode === 'slow' ? 'Slow pace'
        : protocol.speedMode === 'quick' ? 'Quick scan'
          : 'Normal pace',
    )
  }
  if (protocol.staticGridPattern) out.push(`Grid ${protocol.staticGridPattern}`)
  if (protocol.extendedField != null) out.push(protocol.extendedField ? 'Extended field on' : 'Extended field off')
  return out
}

function describeDevice(result: TestResult): string[] {
  const device = result.device
  if (!device) return []
  const out: string[] = []
  if (device.viewportWidth != null && device.viewportHeight != null) {
    out.push(`Viewport ${device.viewportWidth}×${device.viewportHeight}`)
  }
  if (device.screenWidth != null && device.screenHeight != null) {
    out.push(`Screen ${device.screenWidth}×${device.screenHeight}`)
  }
  if (device.pixelRatio != null) out.push(`DPR ${device.pixelRatio}`)
  if (device.fullscreen != null) out.push(device.fullscreen ? 'Fullscreen at capture' : 'Windowed capture')
  if (device.timezone) out.push(device.timezone)
  return out
}

function describeQuality(result: TestResult): string[] {
  const q = result.qualityMetrics
  if (!q) return []
  const out: string[] = []
  if (q.catchTrialsPresented != null) out.push(`Catch trials ${q.catchTrialsPresented}`)
  if (q.catchTrialsFalsePositive != null) out.push(`Catch false positives ${q.catchTrialsFalsePositive}`)
  if (q.falsePositiveIsiPresses != null) out.push(`ISI false positives ${q.falsePositiveIsiPresses}`)
  if (q.truePositiveResponses != null) out.push(`True positives ${q.truePositiveResponses}`)
  if (q.rescueTrialsFired != null) out.push(`Rescue trials ${q.rescueTrialsFired}`)
  return out
}

export function HistoryView({ onBack }: Props) {
  const [results, setResults] = useState<TestResult[]>(() =>
    getResults().sort((a, b) => b.date.localeCompare(a.date))
  )
  const [selected, setSelected] = useState<TestResult | null>(null)
  // Pending delete-confirmation target. Single-eye results hold one id;
  // binocular pair-cards in the list hold both ids so a single confirm
  // tap nukes both eyes of that session (deleting half a pair would
  // leave an orphan that silently shape-shifts the list entry — worse
  // UX than just confirming the whole thing).
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null)
  const [syncedIds, setSyncedIds] = useState<Set<string>>(new Set())
  const [importMessage, setImportMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [showOvfxHelp, setShowOvfxHelp] = useState(false)
  const [surveyOpenForId, setSurveyOpenForId] = useState<string | null>(null)
  const [surveyDoneIds, setSurveyDoneIds] = useState<Set<string>>(new Set())
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

  const handleDelete = (ids: string[]) => {
    for (const id of ids) {
      // Local removal + tombstone (deleteResult writes both — see
      // storage.ts). The tombstone protects the delete against the
      // next mergeFromServer pulling the record back in.
      deleteResult(id)
      // Best-effort server delete. On success, clear the tombstone
      // immediately so it doesn't get retried next sync. On failure
      // (network, 5xx, expired session), the tombstone stays and the
      // sync loop in AuthContext will retry until the server agrees.
      if (user) {
        api.deleteVFResult(id)
          .then(() => removeTombstone(id))
          .catch(() => { /* tombstone retains; sync loop retries */ })
      }
    }
    const idSet = new Set(ids)
    setResults(prev => prev.filter(r => !idSet.has(r.id)))
    if (selected && idSet.has(selected.id)) setSelected(null)
    setConfirmDeleteIds(null)
  }

  const resultHasSurvey = (id: string) => surveyDoneIds.has(id) || hasSurveyForResult(id)

  const handleSurveySubmit = (resultId: string, response: SurveyResponse) => {
    saveSurvey(resultId, response)
    setSurveyDoneIds(prev => new Set(prev).add(resultId))
    setSurveyOpenForId(null)
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
  // Orphan bucket — anything in `results` that didn't land in a
  // paired binocular group OR a left/right single. Catches:
  //   • Legacy results with `eye === 'both'` from before the
  //     single-row binocular format was deprecated.
  //   • Half-deleted binocular pairs (only one eye still on disk;
  //     the pair filter `g.right && g.left` rejects the half-group).
  //   • Hex-grid era runs (pre-24-2) where some fields were
  //     differently named — they have `eye` set but may be missing
  //     other expected fields, and shouldn't be silently dropped.
  // Before this catch-all existed, such results showed up in the
  // "III4e isopter area over time" chart (which only checks for an
  // III4e area) but were invisible in the list — so the user saw a
  // phantom data point they couldn't inspect or delete.
  const placedIds = new Set([
    ...pairedIds,
    ...rightEyeResults.map(r => r.id),
    ...leftEyeResults.map(r => r.id),
  ])
  const orphanResults = results.filter(r => !placedIds.has(r.id))

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
              <span className="ml-2 text-zinc-500">· {selected.testType === 'static' ? 'Static test' : 'Goldmann'}</span>
            )}
          </p>
          {isGoldmannResult(selected) && (
            <VisualFieldMap
              points={standardPoints}
              eye={selected.eye}
              maxEccentricity={maxEcc}
              calibration={selected.calibration}
              enableVerify
            />
          )}
          {/* Layout splits by test type. Static results show only the
              HFA-style block (matches what the post-test results phase
              renders), no per-isopter areas grid or narrative
              Interpretation — those weren't on the post-test page so
              including them here was the only inconsistency between
              "just finished" and "re-opened from history" for the same
              run. Goldmann results keep their existing layout
              (per-isopter areas grid + Interpretation + ScenarioOverlay
              below) — those *are* on Goldmann's post-test results
              phase too, so they stay consistent there. */}
          {!isGoldmannResult(selected) ? (
            <HFAResultsView
              points={standardPoints.filter(p => !p.catchTrial)}
              eye={selected.eye}
              gridPattern={(selected.protocol?.staticGridPattern as StaticGridPattern | undefined) ?? '24-2'}
              date={selected.date}
              durationSeconds={selected.durationSeconds}
              brightnessFloor={selected.calibration.brightnessFloor}
              maxEccentricityDeg={maxEcc}
              fpIsiPresses={selected.qualityMetrics?.falsePositiveIsiPresses}
              truePositiveResponses={selected.qualityMetrics?.truePositiveResponses}
            />
          ) : (
            <>
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {ISOPTER_ORDER.map(key => {
                    const area = selected.isopterAreas[key]
                    if (area == null) return null
                    return (
                      <div key={key} className="bg-surface rounded-xl px-3 py-2 flex items-center gap-2 border border-white/[0.06]">
                        <span className="w-4 text-center" style={{ color: STIMULI[key].color }} aria-hidden="true">{ISOPTER_SHAPES[key] || '●'}</span>
                        <span className="text-zinc-400">{STIMULI[key].label}</span>
                        <span className="ml-auto font-mono" title={isopterStrategyHint(selected.testType)}>
                          {area.toFixed(0)} deg²
                        </span>
                      </div>
                    )
                  })}
                </div>
                <p className="text-[11px] text-zinc-500 leading-snug">
                  Areas measured via <span className="text-zinc-400">Goldmann kinetic</span>.
                  {' '}{isopterStrategyHint(selected.testType)}
                </p>
              </div>
              <Interpretation
                points={standardPoints}
                areas={selected.isopterAreas}
                maxEccentricityDeg={selected.calibration.maxEccentricityDeg}
                calibration={selected.calibration}
                reliabilityIndices={selected.reliabilityIndices}
              />
            </>
          )}
          {/* Scenario comparison (Normal / Early RP / … / Very
              Severe RP) is Goldmann-only. The RP reference
              scenarios derive from full-field kinetic isopter
              areas; static scatter tests (especially Quick / 10-2)
              cap out at a tiny seen-points hull that geometrically
              can't reach the Normal reference area, so static
              results always landed in the most-severe bucket.
              Static reads are still summarised by the
              Interpretation block above. */}
          {selected.testType !== 'static' && (
            <ScenarioOverlay userPoints={standardPoints} userAreas={selected.isopterAreas} maxEccentricity={maxEcc} />
          )}
          {/* Vision simulation disabled for now — see comment in
              StaticTest.tsx. Component file preserved so the feature
              can be re-enabled in place once it handles static
              threshold data more sensibly. */}
          <div className="text-sm text-zinc-500 space-y-1">
            <p>Viewing distance: {selected.calibration.viewingDistanceCm} cm</p>
            <p>Max eccentricity: {selected.calibration.maxEccentricityDeg}°</p>
            <p>Total points: {selected.points.length} ({selected.points.filter(p => p.detected).length} detected)</p>
          </div>
          {/* Clinician / study metadata block only renders for runs
              started from the clinician portal. The `study` field is
              the discriminant — it's populated only when a clinician
              kicks off a session with a study profile attached. The
              other metadata fields (`protocol`, `device`, `provenance`,
              `qualityMetrics`) are always set by the native test
              flow, so gating on "any of these exist" used to show the
              metadata block for every saved result, which was noise
              for self-monitoring users and only meaningful for
              study-tracked runs. */}
          {selected.study && (
            <div className="space-y-3 rounded-xl border border-white/[0.06] bg-surface p-4">
              <h2 className="text-sm font-medium text-white">Clinician / study metadata</h2>
              <div className="space-y-1 text-sm text-zinc-300">
                <p className="text-xs uppercase tracking-[0.08em] text-zinc-500">Study</p>
                <p>
                  Study {selected.study.studyId} · Participant {selected.study.participantId} · Session {selected.study.sessionId}
                  {selected.study.visitId ? ` · Visit ${selected.study.visitId}` : ''}
                  {selected.study.repeatIndex != null ? ` · Repeat ${selected.study.repeatIndex}` : ''}
                  {selected.study.siteId ? ` · Site ${selected.study.siteId}` : ''}
                  {selected.study.operatorId ? ` · Operator ${selected.study.operatorId}` : ''}
                </p>
              </div>
              {selected.protocol && (
                <div className="space-y-1 text-sm text-zinc-300">
                  <p className="text-xs uppercase tracking-[0.08em] text-zinc-500">Protocol</p>
                  <p>{describeProtocol(selected).join(' · ')}</p>
                  {selected.protocol.advancedSettingsSnapshot && (
                    <details className="pt-1 text-xs text-zinc-400">
                      <summary className="cursor-pointer select-none text-zinc-300">Advanced settings snapshot</summary>
                      <pre className="mt-2 overflow-x-auto rounded-lg border border-white/[0.06] bg-black/20 p-3 text-[11px] leading-relaxed text-zinc-400">
                        {JSON.stringify(selected.protocol.advancedSettingsSnapshot, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
              {selected.device && (
                <div className="space-y-1 text-sm text-zinc-300">
                  <p className="text-xs uppercase tracking-[0.08em] text-zinc-500">Acquisition</p>
                  <p>{describeDevice(selected).join(' · ')}</p>
                  {selected.device.platform && (
                    <p className="text-xs text-zinc-500">
                      {selected.device.platform}
                      {selected.device.language ? ` · ${selected.device.language}` : ''}
                    </p>
                  )}
                </div>
              )}
              {selected.qualityMetrics && (
                <div className="space-y-1 text-sm text-zinc-300">
                  <p className="text-xs uppercase tracking-[0.08em] text-zinc-500">Quality signals</p>
                  <p>{describeQuality(selected).join(' · ')}</p>
                </div>
              )}
              {selected.provenance && (
                <div className="space-y-1 text-sm text-zinc-300">
                  <p className="text-xs uppercase tracking-[0.08em] text-zinc-500">Provenance</p>
                  <p>
                    {selected.provenance.source === 'ovfx-import' ? 'Imported from OVFX' : 'Captured natively'}
                    {selected.provenance.sourceDocumentId ? ` · Source doc ${selected.provenance.sourceDocumentId}` : ''}
                    {selected.provenance.sourceSoftwareName ? ` · ${selected.provenance.sourceSoftwareName}` : ''}
                    {selected.provenance.sourceSoftwareVersion ? ` ${selected.provenance.sourceSoftwareVersion}` : ''}
                    {selected.provenance.appVersion ? ` · App ${selected.provenance.appVersion}` : ''}
                  </p>
                </div>
              )}
            </div>
          )}
          <ClinicalDisclaimer variant="results" />

          {resultHasSurvey(selected.id) ? (
            <p className="text-center text-teal text-xs">Feedback saved for this result.</p>
          ) : surveyOpenForId === selected.id ? (
            <PostTestSurvey
              onSubmit={(response: SurveyResponse) => handleSurveySubmit(selected.id, response)}
              onSkip={() => setSurveyOpenForId(null)}
            />
          ) : (
            <button
              onClick={() => setSurveyOpenForId(selected.id)}
              className="w-full py-2.5 bg-surface hover:bg-elevated rounded-xl text-sm font-medium text-zinc-200 transition-colors border border-white/[0.06]"
            >
              Add feedback for this result
            </button>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => exportTrackedResultPDF(selected, undefined, 'history_detail')}
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
              onClick={() => setConfirmDeleteIds([selected.id])}
              className="py-2.5 px-4 bg-surface hover:bg-elevated rounded-xl text-sm text-red-400 hover:text-red-300 transition-colors border border-white/[0.06]"
            >
              Delete
            </button>
          </div>

          {/* Delete confirmation modal is rendered once at the
              page-level bottom of HistoryView, shared across both the
              detail view (here) and the list-card trash buttons. */}
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
                Run your first test from the home screen, or import existing OVFX files from another device.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <button
                onClick={onBack}
                className="inline-flex items-center gap-2 text-sm text-accent hover:text-accent-light transition-colors min-h-[44px] px-3"
              >
                Go to home
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
              <button
                onClick={() => importInputRef.current?.click()}
                className="inline-flex items-center gap-2 text-sm text-zinc-300 hover:text-white bg-surface hover:bg-elevated border border-white/[0.06] rounded-lg min-h-[44px] px-4 transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <path d="M12 3v12" />
                  <path d="m7 10 5 5 5-5" />
                  <path d="M5 21h14" />
                </svg>
                Import OVFX
              </button>
            </div>
          </div>
        )}

        {results.length >= 2 && <AreaChart results={results} />}

        {/* Binocular combined view used to live here as a VisionSimulator
            preview. Removed — it was a heavy compute-on-every-render
            block stacked above the list, the list itself is the focus
            of this page, and the same combined-binocular sim is still
            available inside any individual result's detail view via the
            "Vision simulation" collapsible. Keeping it on the list
            crowded the page and made every history visit do the work
            of rendering it, even when the user just wanted to find or
            delete a specific past result. */}

        {(binocularGroups.length > 0 || rightEyeResults.length > 0 || leftEyeResults.length > 0 || orphanResults.length > 0) && (
          <ResultsList
            binocularGroups={binocularGroups}
            singleResults={[...rightEyeResults, ...leftEyeResults, ...orphanResults]}
            onSelect={setSelected}
            onDelete={ids => setConfirmDeleteIds(ids)}
            onExportPDF={entry => {
              if (entry.kind === 'single') {
                exportTrackedResultPDF(entry.result, undefined, 'history_list')
                return
              }
              // Binocular pair — render as combined OU report.
              const anchor = entry.right ?? entry.left
              if (!anchor) return
              const rightPoints = entry.right?.points ?? []
              const leftPoints = entry.left?.points ?? []
              const combined = [...rightPoints, ...leftPoints]
              exportTrackedResultPDF(
                { ...anchor, points: combined },
                { binocular: true, rightEyePoints: rightPoints, leftEyePoints: leftPoints },
                'history_list',
              )
            }}
            syncedIds={syncedIds}
            showSync={!!user}
          />
        )}
      </main>

      {/* Delete confirmation dialog — shared by both the detail view
          and the list-card trash buttons. `confirmDeleteIds` is a list
          because binocular pair cards delete both eyes of a session as
          a unit; the copy below pluralises when there's more than one. */}
      {confirmDeleteIds && confirmDeleteIds.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            aria-describedby="delete-confirm-desc"
            className="bg-surface border border-white/[0.08] rounded-2xl p-6 w-full max-w-xs space-y-4 shadow-2xl animate-page-in"
          >
            <h2 id="delete-confirm-title" className="text-lg font-heading font-bold text-white">
              Delete {confirmDeleteIds.length > 1 ? 'both results' : 'result'}?
            </h2>
            <p id="delete-confirm-desc" className="text-zinc-400 text-sm">
              {confirmDeleteIds.length > 1
                ? 'This will permanently remove both eyes of this binocular session. This action cannot be undone.'
                : 'This will permanently remove this test result. This action cannot be undone.'}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDeleteIds(null)}
                className="flex-1 py-2.5 bg-elevated hover:bg-overlay rounded-xl text-sm font-medium transition-colors"
                autoFocus
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDeleteIds)}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 rounded-xl text-sm font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type ListEntry =
  | { kind: 'single'; result: TestResult; date: string }
  | { kind: 'pair'; groupId: string; right?: TestResult; left?: TestResult; date: string }

/** Short qualifier shown after the III4e area number in list rows. */
function isopterStrategyShort(t?: string): string {
  if (t === 'static') return '(static)'
  if (t === 'goldmann') return '(kinetic)'
  return ''
}
/** Tooltip text explaining why the same-eye area differs between strategies. */
function isopterStrategyHint(t?: string): string {
  if (t === 'static') return 'Static scatter: polygon fits only locations where III4e was actually detected. Tends to be 30–60% smaller than kinetic on the same eye.'
  if (t === 'goldmann') return 'Goldmann kinetic: polygon traces the inward-detection boundary. Typically 1.5–4× larger than a static III4e isopter on the same eye.'
  return ''
}

function testTypeBadge(t?: string) {
  if (!t) return null
  const cls = t === 'static' ? 'bg-teal/10 text-teal' : 'bg-accent/10 text-accent'
  const label = t === 'static' ? 'Static' : 'Goldmann'
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
  onDelete,
  onExportPDF,
  syncedIds,
  showSync,
}: {
  binocularGroups: { groupId: string; right?: TestResult; left?: TestResult; date: string }[]
  singleResults: TestResult[]
  onSelect: (r: TestResult) => void
  /** Called when the trash button on a card is tapped. The parent
   *  handles the actual confirmation+deletion; this callback just
   *  signals "the user wants to delete these ids". Single-eye cards
   *  pass [id]; binocular pair cards pass both eye ids so a single
   *  confirm nukes the whole session. */
  onDelete: (ids: string[]) => void
  onExportPDF: (entry: ListEntry) => void
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
          // Orphan results with a non-standard `eye` field (legacy
          // `'both'`, missing, etc.) fall through both side-checks and
          // get rendered as a "legacy OU" entry with no per-eye open
          // buttons — surfaced only so the user can see and delete them.
          const isStandardEye = entry.kind === 'single'
            && (entry.result.eye === 'left' || entry.result.eye === 'right')
          const leftResult = entry.kind === 'single'
            ? (entry.result.eye === 'left' ? entry.result : undefined)
            : entry.left
          const rightResult = entry.kind === 'single'
            ? (entry.result.eye === 'right' ? entry.result : undefined)
            : entry.right
          const eyeBadgeCls = 'bg-accent/10 text-accent'
          const eyeBadgeLabel: 'OD' | 'OS' | 'OU' = entry.kind === 'single'
            ? (isStandardEye ? formatEyeLabel(entry.result.eye) : 'OU')
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
                  {/* Delete — trash icon. Single-eye entries hand a
                      one-element list to the parent; binocular pair
                      cards hand both eye ids so the confirm dialog
                      surfaces "Delete both results?" and a single
                      tap removes the whole session. */}
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      if (entry.kind === 'single') {
                        onDelete([entry.result.id])
                      } else {
                        const ids: string[] = []
                        if (entry.left) ids.push(entry.left.id)
                        if (entry.right) ids.push(entry.right.id)
                        if (ids.length > 0) onDelete(ids)
                      }
                    }}
                    aria-label="Delete result"
                    title="Delete result"
                    className="w-7 h-7 flex items-center justify-center rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                      <path d="M3 6h18" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                {entry.kind === 'single' && !isStandardEye ? (
                  // Orphan single-eye entry — non-standard `eye` field
                  // (legacy 'both' or unknown). Render one full-width
                  // "open" button so the user can inspect what's in it
                  // and then decide whether to keep or delete via the
                  // trash icon above. Skip the per-eye OS / OD layout
                  // because we have no eye to assign it to.
                  <button
                    onClick={() => onSelect(entry.result)}
                    className="flex-1 px-3 py-2 bg-elevated hover:bg-overlay rounded-xl text-xs text-left transition-colors border border-white/[0.04] flex items-center gap-2"
                  >
                    {showSync && <SyncIndicator synced={syncedIds.has(entry.result.id)} />}
                    <span className="text-zinc-300 font-medium">Legacy result — tap to view</span>
                    {entry.result.isopterAreas['III4e'] != null && (
                      <span className="ml-auto font-mono text-teal">
                        {entry.result.isopterAreas['III4e']!.toFixed(0)} deg²
                      </span>
                    )}
                  </button>
                ) : leftResult ? (
                  <button
                    onClick={() => onSelect(leftResult)}
                    className="flex-1 px-3 py-2 bg-elevated hover:bg-overlay rounded-xl text-xs text-left transition-colors border border-white/[0.04] flex items-center gap-2"
                  >
                    {showSync && <SyncIndicator synced={syncedIds.has(leftResult.id)} />}
                    <span className="text-zinc-300 font-medium">OS (Left)</span>
                    {leftResult.isopterAreas['III4e'] != null && (
                      <span
                        className="ml-auto font-mono text-teal"
                        title={isopterStrategyHint(leftResult.testType)}
                      >
                        {leftResult.isopterAreas['III4e']!.toFixed(0)} deg²
                        {leftResult.testType && (
                          <span className="text-zinc-500 font-sans ml-1">{isopterStrategyShort(leftResult.testType)}</span>
                        )}
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="flex-1 px-3 py-2 rounded-xl text-xs text-zinc-600 text-left border border-dashed border-white/[0.04]">
                    OS (Left) — not tested
                  </div>
                )}
                {entry.kind === 'single' && !isStandardEye ? null : rightResult ? (
                  <button
                    onClick={() => onSelect(rightResult)}
                    className="flex-1 px-3 py-2 bg-elevated hover:bg-overlay rounded-xl text-xs text-left transition-colors border border-white/[0.04] flex items-center gap-2"
                  >
                    {showSync && <SyncIndicator synced={syncedIds.has(rightResult.id)} />}
                    <span className="text-zinc-300 font-medium">OD (Right)</span>
                    {rightResult.isopterAreas['III4e'] != null && (
                      <span
                        className="ml-auto font-mono text-teal"
                        title={isopterStrategyHint(rightResult.testType)}
                      >
                        {rightResult.isopterAreas['III4e']!.toFixed(0)} deg²
                        {rightResult.testType && (
                          <span className="text-zinc-500 font-sans ml-1">{isopterStrategyShort(rightResult.testType)}</span>
                        )}
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="flex-1 px-3 py-2 rounded-xl text-xs text-zinc-600 text-left border border-dashed border-white/[0.04]">
                    OD (Right) — not tested
                  </div>
                )}
              </div>
              {[leftResult, rightResult].map((result, ri) => result?.reliabilityIndices && result.reliabilityIndices.catchTrialsPresented > 0 && (() => {
                const {
                  catchTrialsPresented,
                  catchTrialsFalsePositive,
                  falsePositiveIsiPresses,
                  truePositiveResponses,
                } = result.reliabilityIndices!
                const faCorrect = catchTrialsPresented - catchTrialsFalsePositive
                const faPct = (faCorrect / catchTrialsPresented) * 100
                const fprrN = catchTrialsFalsePositive + falsePositiveIsiPresses
                const fprrD = fprrN + truePositiveResponses
                const fprrPct = fprrD > 0 ? (fprrN / fprrD) * 100 : 0
                return (
                  <div key={ri} className="space-y-0.5">
                    <div
                      className="text-sm text-zinc-400"
                      title="Fixation Accuracy — % of blindspot catch trials correctly ignored. Normal 79–99% (Dzwiniel 2017)."
                    >
                      <span className="font-medium">FA: </span>
                      {faPct.toFixed(0)}% ({faCorrect}/{catchTrialsPresented})
                      <span className="text-zinc-500"> · normal 79–99%</span>
                    </div>
                    {fprrD > 0 && (
                      <div
                        className="text-sm text-zinc-400"
                        title="False-Positive Response Rate — % of key presses when no stimulus was shown. Normal 0.3–2.3% (Dzwiniel 2017)."
                      >
                        <span className="font-medium">FPRR: </span>
                        {fprrPct.toFixed(1)}%
                        <span className="text-zinc-500"> · normal 0.3–2.3%</span>
                      </div>
                    )}
                  </div>
                )
              })())}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Per-test-type colors for the isopter trend chart. Static and kinetic
 *  produce III4e areas on different scales (kinetic typically 1.5–4×
 *  larger on the same eye — see the test-type caption below), so we never
 *  connect them with a single line. */
const TEST_TYPE_COLORS: Record<string, string> = {
  static: '#2dd4bf',   // teal — matches the Static badge
  goldmann: '#fb923c', // orange — matches the Goldmann badge
}
const TEST_TYPE_LABELS: Record<string, string> = {
  static: 'Static (scatter)',
  goldmann: 'Goldmann (kinetic)',
}

function AreaChart({ results }: { results: TestResult[] }) {
  const sorted = [...results].sort((a, b) => a.date.localeCompare(b.date))

  // Group by testType. Static-scatter and Goldmann-kinetic produce the
  // III4e area via different algorithms (seen-points hull vs. kinetic
  // sweep endpoints) and shouldn't share a line.
  const byType = new Map<string, { date: string; area: number }[]>()
  for (const r of sorted) {
    const area = r.isopterAreas['III4e']
    if (area == null) continue
    const type = r.testType ?? 'unknown'
    const arr = byType.get(type) ?? []
    arr.push({ date: r.date, area })
    byType.set(type, arr)
  }

  // Chart only useful when at least ONE strategy has ≥2 points.
  const hasLine = [...byType.values()].some(arr => arr.length >= 2)
  if (!hasLine) return null

  const allPoints = [...byType.values()].flat()
  const maxArea = Math.max(...allPoints.map(d => d.area), 1)
  // Normalize all series along a shared time axis (index-based, not
  // real-time), so each series' first point is at x=0 and last is at x=1
  // relative to the ALL-points timeline. We use min/max date for that.
  const allDates = allPoints.map(d => d.date).sort()
  const minDate = allDates[0]
  const maxDate = allDates[allDates.length - 1]
  const spanMs = Math.max(1, new Date(maxDate).getTime() - new Date(minDate).getTime())

  const w = 600
  const h = 160
  const px = 40
  const py = 20
  const rightPad = 20

  const xFor = (date: string) => {
    const t = new Date(date).getTime() - new Date(minDate).getTime()
    return px + ((w - px - rightPad) * t) / spanMs
  }
  const yFor = (area: number) => py + (h - 2 * py) * (1 - area / maxArea)

  const series = [...byType.entries()]
    .map(([type, arr]) => ({
      type,
      color: TEST_TYPE_COLORS[type] ?? '#a1a1aa',
      label: TEST_TYPE_LABELS[type] ?? type,
      points: arr.map(d => ({ x: xFor(d.date), y: yFor(d.area), date: d.date, area: d.area })),
    }))

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between flex-wrap gap-x-3 gap-y-1">
        <h2 className="text-sm text-zinc-400 font-heading font-semibold">
          III4e isopter area over time
        </h2>
        <div className="flex items-center gap-3 text-[10px] text-zinc-500" aria-label="Test-type legend">
          {series.map(s => (
            <span key={s.type} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block rounded-full" style={{ width: 8, height: 8, background: s.color }} />
              <span>{s.label}</span>
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxWidth: w }} role="img" aria-label="Chart showing III4e isopter area trend over time, split by test type">
        <text x={px - 4} y={py + 4} fill="#71717a" fontSize={10} textAnchor="end">
          {maxArea.toFixed(0)}
        </text>
        <text x={px - 4} y={h - py + 4} fill="#71717a" fontSize={10} textAnchor="end">
          0
        </text>
        <line x1={px} y1={py} x2={px} y2={h - py} stroke="#27272a" strokeWidth={0.5} />
        <line x1={px} y1={h - py} x2={w - rightPad} y2={h - py} stroke="#27272a" strokeWidth={0.5} />
        {series.map(s => {
          const linePath = s.points.length >= 2
            ? s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
            : null
          return (
            <g key={s.type}>
              {linePath && <path d={linePath} fill="none" stroke={s.color} strokeWidth={2} />}
              {s.points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={4} fill={s.color}>
                  <title>{`${s.label}: ${p.area.toFixed(0)} deg² · ${new Date(p.date).toLocaleDateString()}`}</title>
                </circle>
              ))}
            </g>
          )
        })}
        {/* X-axis date labels at min/max of the combined timeline */}
        <text x={px} y={h - 2} fill="#71717a" fontSize={9} textAnchor="start">
          {new Date(minDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </text>
        <text x={w - rightPad} y={h - 2} fill="#71717a" fontSize={9} textAnchor="end">
          {new Date(maxDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </text>
      </svg>
      <p className="text-[11px] text-zinc-500 leading-snug">
        Static and kinetic isopter areas aren't directly comparable — kinetic
        sweeps record only the detection boundary while static scatter tests
        can leave seen-points clustered near fovea. Expect kinetic III4e area
        to be 1.5–4× the static area on the same eye.
      </p>
    </div>
  )
}
