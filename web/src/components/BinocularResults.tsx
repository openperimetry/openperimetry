import { useState, useEffect, useRef } from 'react'
import type { CalibrationData, RunSpeedMode, TestPoint, TestResult } from '../types'
import { useAuth } from '../AuthContext'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { VisualFieldMap } from './VisualFieldMap'
import { SensitivityMap } from './SensitivityMap'
import { calcIsopterAreas } from '../isopterCalc'
import { Interpretation } from './Interpretation'
import { saveResult, saveSurvey, hasSurveyForResult, hasBeenPromptedForFeedback, markFeedbackPrompted } from '../storage'
import { exportTrackedResultPDF } from '../pdfExportTracking'
import { ScenarioOverlay } from './ScenarioOverlay'
import { formatEyeLabel } from '../eyeLabels'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'
import { SavePrompt } from './SavePrompt'
import { PostTestSurvey } from './PostTestSurvey'
import type { SurveyResponse } from './PostTestSurvey'
import { useAdvancedSettings } from '../advancedSettings'
import { useStudyMode } from '../studyMode'
import {
  buildNativeProvenance,
  buildProtocolSnapshot,
  buildStudyMetadata,
  captureDeviceMetadata,
} from '../resultMetadata'

interface Props {
  rightPoints: TestPoint[]
  leftPoints: TestPoint[]
  calibration: CalibrationData
  maxEccentricity: number
  /** Which test produced these points. Determines whether the visual-field
   *  isopter plot (Goldmann kinetic) or the dB sensitivity heatmap (static)
   *  is rendered. Legacy in-memory sessions only flow through Goldmann, so
   *  omitting this prop defaults to Goldmann. */
  testMode?: 'goldmann' | 'static'
  speedMode?: RunSpeedMode
  extendedField?: boolean
  onDone: () => void
}

/**
 * For the binocular (combined) field, we take the best response at each
 * meridian — i.e. the furthest eccentricity detected from either eye.
 * This represents the functional visual field with both eyes open.
 */
function combineBinocularPoints(
  rightPoints: TestPoint[],
  leftPoints: TestPoint[],
): TestPoint[] {
  // Group by stimulus + meridian, keep best eccentricity
  const map = new Map<string, TestPoint>()

  for (const p of [...rightPoints, ...leftPoints]) {
    if (!p.detected) continue
    const key = `${p.stimulus}:${p.meridianDeg}`
    const existing = map.get(key)
    if (!existing || p.eccentricityDeg > existing.eccentricityDeg) {
      map.set(key, p)
    }
  }

  // Also include misses only if NEITHER eye detected at that meridian+stimulus
  const detectedKeys = new Set(map.keys())
  for (const p of [...rightPoints, ...leftPoints]) {
    if (p.detected) continue
    const key = `${p.stimulus}:${p.meridianDeg}`
    if (!detectedKeys.has(key)) {
      map.set(key, p) // miss — neither eye saw it
    }
  }

  return Array.from(map.values())
}

export function BinocularResults({
  rightPoints,
  leftPoints,
  calibration,
  maxEccentricity,
  testMode = 'goldmann',
  speedMode,
  extendedField = false,
  onDone,
}: Props) {
  const isGoldmann = testMode === 'goldmann'
  const { user, syncResults } = useAuth()
  const advanced = useAdvancedSettings()
  const studyMode = useStudyMode()
  const [tab, setTab] = useState<'combined' | 'right' | 'left'>('combined')
  const [savedIds, setSavedIds] = useState<{ right?: string; left?: string }>({})
  const savedAny = savedIds.right != null || savedIds.left != null
  const surveyResultId = savedIds.right ?? savedIds.left ?? null
  const [surveyDone, setSurveyDone] = useState(false)
  const [feedbackTrigger, setFeedbackTrigger] = useState<'done' | 'pdf' | null>(null)
  // Retain the TestResults built at mount so we can retry persistence if
  // the user signs in after the binocular results are shown. saveResult
  // no-ops for anonymous users; this ref lets us replay the save once
  // the user has an account.
  const lastResultsRef = useRef<{ right?: TestResult; left?: TestResult }>({})

  const combinedPoints = combineBinocularPoints(rightPoints, leftPoints)

  const rightStandard = rightPoints.filter(p => p.eccentricityDeg <= maxEccentricity + 2)
  const leftStandard = leftPoints.filter(p => p.eccentricityDeg <= maxEccentricity + 2)
  const combinedStandard = combinedPoints.filter(p => p.eccentricityDeg <= maxEccentricity + 2)

  const combinedAreas = calcIsopterAreas(combinedStandard)
  const rightAreas = calcIsopterAreas(rightStandard)
  const leftAreas = calcIsopterAreas(leftStandard)

  // For the combined calibration, use centered fixation (no offset)
  const combinedCalibration: CalibrationData = {
    ...calibration,
    fixationOffsetPx: 0, // symmetric for binocular view
  }

  // Auto-save on mount. A binocular session is stored as TWO single-eye
  // TestResults sharing a binocularGroup UUID — this keeps the data model
  // uniform (no more eye: 'both' rows) while still letting the UI regroup
  // them by binocularGroup for display. If the user skipped one eye, save
  // just the tested side without a binocularGroup — it's not really a
  // binocular session.
  useEffect(() => {
    if (savedAny) return
    if (combinedPoints.length === 0) return

    const hasRight = rightPoints.length > 0
    const hasLeft = leftPoints.length > 0
    const isTrueBinocular = hasRight && hasLeft
    const groupId = isTrueBinocular ? crypto.randomUUID() : undefined
    const date = new Date().toISOString()
    const next: { right?: string; left?: string } = {}
    const study = buildStudyMetadata(studyMode)
    const protocol = buildProtocolSnapshot({
      studyMode,
      testType: testMode,
      testMode: testMode === 'static' ? 'threshold' : 'suprathreshold',
      speedMode,
      extendedField: testMode === 'goldmann' ? extendedField : undefined,
      advancedSettings: advanced,
    })
    const device = captureDeviceMetadata()
    const provenance = buildNativeProvenance()

    if (hasRight) {
      const rightId = crypto.randomUUID()
      const rightResult: TestResult = {
        id: rightId,
        eye: 'right',
        date,
        points: rightPoints,
        isopterAreas: rightAreas,
        calibration,
        testType: testMode,
        binocularGroup: groupId,
        protocol,
        ...(study ? { study } : {}),
        device,
        provenance,
      }
      lastResultsRef.current.right = rightResult
      saveResult(rightResult)
      next.right = rightId
    }
    if (hasLeft) {
      const leftId = crypto.randomUUID()
      // Left eye was tested with a mirrored fixation offset at runtime, but
      // the stored calibration object is the session's original calibration
      // (right-eye-first). We save the same calibration object for both eyes
      // so the downstream verify/export can re-derive the mirrored offset
      // from result.eye. Consumers that want the exact left-eye fixation
      // offset can flip the sign when result.eye === 'left'.
      const leftResult: TestResult = {
        id: leftId,
        eye: 'left',
        date,
        points: leftPoints,
        isopterAreas: leftAreas,
        calibration,
        testType: testMode,
        binocularGroup: groupId,
        protocol,
        ...(study ? { study } : {}),
        device,
        provenance,
      }
      lastResultsRef.current.left = leftResult
      saveResult(leftResult)
      next.left = leftId
    }
    setSavedIds(next)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // If the user signs in after finishing the binocular test, retry
  // persistence so both eyes land on their new account. saveResult is
  // idempotent by id.
  useEffect(() => {
    if (!user) return
    const { right, left } = lastResultsRef.current
    if (!right && !left) return
    if (right) saveResult(right)
    if (left) saveResult(left)
    syncResults()
  }, [user, syncResults])

  const shouldPromptForFeedback = () => (
    surveyResultId != null
    && !surveyDone
    && !hasSurveyForResult(surveyResultId)
    && !hasBeenPromptedForFeedback()
  )

  const openFeedbackPrompt = (trigger: 'done' | 'pdf') => {
    markFeedbackPrompted()
    setFeedbackTrigger(trigger)
  }

  const handleDoneFromResults = () => {
    if (shouldPromptForFeedback()) {
      openFeedbackPrompt('done')
      return
    }
    onDone()
  }

  const closeFeedbackModal = () => {
    const trigger = feedbackTrigger
    setFeedbackTrigger(null)
    if (trigger === 'done') onDone()
  }

  const handleFeedbackSubmit = (response: SurveyResponse) => {
    if (surveyResultId) {
      saveSurvey(surveyResultId, response)
      setSurveyDone(true)
    }
    closeFeedbackModal()
  }

  const activePoints = tab === 'combined' ? combinedStandard : tab === 'right' ? rightStandard : leftStandard
  const activeEye = tab === 'combined' ? 'right' as const : tab // 'right' convention for combined display

  const mapSize = Math.min(600, window.innerWidth - 48)

  return (
    <div className="min-h-[100dvh] bg-base text-white safe-pad p-6 overflow-y-auto animate-page-in">
      <div className="max-w-lg mx-auto space-y-6 pb-12">
        <h2 className="text-2xl font-heading font-bold text-center">Binocular Results</h2>

        {savedAny && <SavePrompt />}

        <ClinicalDisclaimer variant="results" />

        {/* Tab switcher */}
        <div className="flex bg-surface rounded-2xl p-1 gap-1 border border-white/[0.04]">
          {(['combined', 'right', 'left'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                tab === t
                  ? 'btn-primary text-white'
                  : 'text-zinc-400 hover:text-white hover:bg-elevated'
              }`}
            >
              {t === 'combined' ? 'Both eyes' : t === 'right' ? 'OD (Right)' : 'OS (Left)'}
            </button>
          ))}
        </div>

        {/* Radar — only the Goldmann (kinetic) flow produces isopters to
            render here. Static sessions show the sensitivity heatmap below. */}
        {isGoldmann && (
          tab === 'combined' ? (
            <div className="relative">
              <VisualFieldMap
                points={combinedStandard}
                eye="right"
                maxEccentricity={maxEccentricity}
                size={mapSize}
                calibration={combinedCalibration}
                enableVerify
              />
              <p className="text-center text-xs text-zinc-500 mt-1">
                Combined field — best response from either eye at each direction
              </p>
            </div>
          ) : (
            <VisualFieldMap
              points={activePoints}
              eye={activeEye}
              maxEccentricity={maxEccentricity}
              size={mapSize}
              calibration={calibration}
              enableVerify
            />
          )
        )}

        {/* Area comparison table */}
        {tab === 'combined' ? (
          <div className="space-y-2">
            <div className="grid grid-cols-4 gap-2 text-xs text-zinc-500 px-1">
              <span>Isopter</span>
              <span className="text-center">OD</span>
              <span className="text-center">OS</span>
              <span className="text-center text-accent">Both</span>
            </div>
            {ISOPTER_ORDER.map(key => {
              const r = rightAreas[key]
              const l = leftAreas[key]
              const c = combinedAreas[key]
              if (r == null && l == null && c == null) return null
              return (
                <div
                  key={key}
                  className="grid grid-cols-4 gap-2 bg-surface rounded-xl px-3 py-2 items-center text-sm border border-white/[0.06]"
                >
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STIMULI[key].color }} />
                    {STIMULI[key].label}
                  </span>
                  <span className="text-center font-mono text-zinc-300">
                    {r != null ? `${r.toFixed(0)}°²` : '—'}
                  </span>
                  <span className="text-center font-mono text-zinc-300">
                    {l != null ? `${l.toFixed(0)}°²` : '—'}
                  </span>
                  <span className="text-center font-mono text-accent">
                    {c != null ? `${c.toFixed(0)}°²` : '—'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 text-xs text-zinc-500 px-1">
              <span>Isopter</span>
              <span className="text-center">{formatEyeLabel(tab as 'right' | 'left')}</span>
            </div>
            {ISOPTER_ORDER.map(key => {
              const area = (tab === 'right' ? rightAreas : leftAreas)[key]
              if (area == null) return null
              return (
                <div
                  key={key}
                  className="grid grid-cols-2 gap-2 bg-surface rounded-xl px-3 py-2 items-center text-sm border border-white/[0.06]"
                >
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STIMULI[key].color }} />
                    {STIMULI[key].label}
                  </span>
                  <span className="text-center font-mono text-zinc-300">
                    {`${area.toFixed(0)}°²`}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* Sensitivity heatmap — rendered only for threshold-mode static
            tests that carry per-location thresholdDb. Goldmann shows the
            isopter radar above instead; legacy suprathreshold static
            imports carry no measured dB and render nothing here. */}
        {!isGoldmann && (() => {
          const source = tab === 'combined' ? combinedStandard : activePoints
          const measured = source
            .filter(p => p.thresholdDb != null && !p.catchTrial)
            .map(p => ({
              meridianDeg: p.meridianDeg,
              eccentricityDeg: p.eccentricityDeg,
              db: p.thresholdDb!,
            }))
          if (measured.length === 0) return null
          return (
            <SensitivityMap
              points={measured}
              eye={tab === 'combined' ? 'right' : activeEye}
              maxEccentricity={maxEccentricity}
              size={mapSize}
            />
          )
        })()}

        {/* Interpretation */}
        <Interpretation
          points={activePoints}
          areas={tab === 'combined' ? combinedAreas : tab === 'right' ? rightAreas : leftAreas}
          maxEccentricityDeg={maxEccentricity}
          calibration={calibration}
        />
        {tab === 'combined' && (
          <ScenarioOverlay userPoints={combinedStandard} userAreas={combinedAreas} maxEccentricity={maxEccentricity} />
        )}

        {/* Vision simulation disabled for now — see comment in
            StaticTest.tsx. */}

        <div className="flex gap-3">
          <button
            onClick={() => {
              if (!savedAny) return
              // The PDF export takes a TestResult shaped like the screen it's
              // rendering — the combined binocular view. The saved-to-storage
              // records are two single-eye TestResults; this is a transient
              // render object. We mark it 'right' (arbitrary) and pass the
              // binocular flag so pdfExport renders the OU labels + per-eye
              // radars.
              const result: TestResult = {
                id: savedIds.right ?? savedIds.left ?? crypto.randomUUID(),
                eye: 'right',
                date: new Date().toISOString(),
                points: combinedStandard,
                isopterAreas: combinedAreas,
                calibration,
                testType: testMode,
                testMode: testMode === 'static' ? 'threshold' : 'suprathreshold',
              }
              exportTrackedResultPDF(result, {
                binocular: true,
                rightEyePoints: rightPoints,
                leftEyePoints: leftPoints,
              }, 'binocular_results')
              if (shouldPromptForFeedback()) openFeedbackPrompt('pdf')
            }}
            className="flex-1 py-3 btn-primary rounded-xl font-medium text-white"
          >
            Export PDF
          </button>
          <button
            onClick={handleDoneFromResults}
            className="flex-1 py-3 bg-elevated hover:bg-overlay rounded-xl font-medium transition-colors"
          >
            Done
          </button>
        </div>
        {surveyDone && (
          <p className="text-center text-green-400 text-xs">Thank you for your feedback!</p>
        )}
      </div>

      {feedbackTrigger && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Quick feedback"
          onClick={closeFeedbackModal}
        >
          <div className="w-full max-w-md" onClick={e => e.stopPropagation()}>
            <PostTestSurvey
              onSubmit={handleFeedbackSubmit}
              onSkip={closeFeedbackModal}
            />
          </div>
        </div>
      )}
    </div>
  )
}
