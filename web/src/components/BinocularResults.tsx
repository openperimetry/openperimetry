import { useState, useEffect } from 'react'
import type { TestPoint, TestResult, CalibrationData } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { VisualFieldMap } from './VisualFieldMap'
import { SensitivityMap } from './SensitivityMap'
import { deriveDbFromSuprathreshold } from '../sensitivity'
import { calcIsopterAreas } from '../isopterCalc'
import { Interpretation } from './Interpretation'
import { VisionSimulator } from './VisionSimulator'
import { saveResult } from '../storage'
import { exportTrackedResultPDF } from '../pdfExportTracking'
import { ScenarioOverlay } from './ScenarioOverlay'
import { formatEyeLabel } from '../eyeLabels'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'

interface Props {
  rightPoints: TestPoint[]
  leftPoints: TestPoint[]
  calibration: CalibrationData
  maxEccentricity: number
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
  onDone,
}: Props) {
  const [tab, setTab] = useState<'combined' | 'right' | 'left'>('combined')
  const [savedIds, setSavedIds] = useState<{ right?: string; left?: string }>({})
  const savedAny = savedIds.right != null || savedIds.left != null

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

    if (hasRight) {
      const rightId = crypto.randomUUID()
      saveResult({
        id: rightId,
        eye: 'right',
        date,
        points: rightPoints,
        isopterAreas: rightAreas,
        calibration,
        testType: 'goldmann',
        binocularGroup: groupId,
      })
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
      saveResult({
        id: leftId,
        eye: 'left',
        date,
        points: leftPoints,
        isopterAreas: leftAreas,
        calibration,
        testType: 'goldmann',
        binocularGroup: groupId,
      })
      next.left = leftId
    }
    setSavedIds(next)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activePoints = tab === 'combined' ? combinedStandard : tab === 'right' ? rightStandard : leftStandard
  const activeEye = tab === 'combined' ? 'right' as const : tab // 'right' convention for combined display

  const mapSize = Math.min(600, window.innerWidth - 48)

  return (
    <div className="min-h-[100dvh] bg-base text-white safe-pad p-6 overflow-y-auto animate-page-in">
      <div className="max-w-lg mx-auto space-y-6 pb-12">
        <h2 className="text-2xl font-heading font-bold text-center">Binocular Results</h2>

        {savedAny && (
          <p className="text-center text-teal text-xs">
            Saved automatically — this session is now available on the Results page.
          </p>
        )}

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

        {/* Radar */}
        {tab === 'combined' ? (
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

        {/* Derived sensitivity heatmap (placed after isopter-area table so
            the area legend sits directly under the field map it describes) */}
        <SensitivityMap
          points={deriveDbFromSuprathreshold(tab === 'combined' ? combinedStandard : activePoints)}
          eye={tab === 'combined' ? 'right' : activeEye}
          maxEccentricity={maxEccentricity}
          size={mapSize}
          source="derived"
        />

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

        {/* Vision simulation */}
        {tab === 'combined' ? (
          <VisionSimulator
            points={combinedStandard}
            eye="right"
            maxEccentricity={maxEccentricity}
            secondEyePoints={leftStandard}
            secondEyeMaxEccentricity={maxEccentricity}
          />
        ) : (
          <VisionSimulator
            points={activePoints}
            eye={activeEye}
            maxEccentricity={maxEccentricity}
          />
        )}

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
              }
              exportTrackedResultPDF(result, {
                binocular: true,
                rightEyePoints: rightPoints,
                leftEyePoints: leftPoints,
              }, 'binocular_results')
            }}
            className="flex-1 py-3 btn-primary rounded-xl font-medium text-white"
          >
            Export PDF
          </button>
          <button
            onClick={onDone}
            className="flex-1 py-3 bg-elevated hover:bg-overlay rounded-xl font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
