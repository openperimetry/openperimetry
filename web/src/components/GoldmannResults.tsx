import type { ReactNode } from 'react'
import type { CalibrationData, StoredEye, TestPoint, TestResult } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { VisualFieldMap } from './VisualFieldMap'
import { calcIsopterAreas } from '../isopterCalc'
import { detectTruncatedIsopters } from '../goldmannCoverage'
import { Interpretation } from './Interpretation'
import { ScenarioOverlay } from './ScenarioOverlay'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'

interface Props {
  /** In-field, consolidated Goldmann points to plot/score. */
  points: TestPoint[]
  eye: StoredEye
  maxEccentricityDeg: number
  /** Calibration for Interpretation + ScenarioOverlay classification math. */
  calibration?: CalibrationData
  /** Calibration passed to the field map. Omit for synthetic/demo data so the
   *  "not tested" halo doesn't misrepresent points beyond a real screen. */
  mapCalibration?: CalibrationData
  /** Plotted extent for the field map (rings/scale). Defaults to maxEccentricity. */
  mapPlotExtentDeg?: number
  /** Field map size in px. Defaults to a responsive min(600, vw-48). */
  mapSize?: number
  /** Show the 1:1 verify button (requires real calibration). Default false. */
  enableVerify?: boolean
  /** Show the "isopter boundary not reached" warning. Off for synthetic demo
   *  data, whose points intentionally sit beyond the plotted extent — the
   *  "sit closer / recalibrate" advice is meaningless there. Default true. */
  showTruncation?: boolean
  showReliability?: boolean
  reliabilityIndices?: TestResult['reliabilityIndices']
  /** Slot rendered between the subtitle and the field map (e.g. SavePrompt). */
  beforeMap?: ReactNode
  /** Action bar / extras rendered at the bottom of the report. */
  footer?: ReactNode
}

/** The Goldmann single-field results report. One source of truth shared by the
 *  live test results screen and the clinical scenario demo. */
export function GoldmannResults({
  points,
  eye,
  maxEccentricityDeg,
  calibration,
  mapCalibration,
  mapPlotExtentDeg,
  mapSize,
  enableVerify = false,
  showTruncation = true,
  showReliability = false,
  reliabilityIndices,
  beforeMap,
  footer,
}: Props) {
  const areas = calcIsopterAreas(points)
  const size = mapSize ?? (typeof window !== 'undefined' ? Math.min(600, window.innerWidth - 48) : 600)
  const truncated = showTruncation ? detectTruncatedIsopters(points, maxEccentricityDeg) : []

  return (
    <main className="max-w-lg mx-auto space-y-6 pb-12">
      <h1 className="text-2xl font-semibold text-center">Results</h1>
      <p className="text-center text-xs text-muted">Goldmann kinetic perimetry · {eye === 'right' ? <abbr title="Oculus Dexter">OD</abbr> : <abbr title="Oculus Sinister">OS</abbr>}</p>
      {beforeMap}
      <VisualFieldMap
        points={points}
        eye={eye}
        maxEccentricity={maxEccentricityDeg}
        plotExtentDeg={mapPlotExtentDeg}
        size={size}
        calibration={mapCalibration}
        enableVerify={enableVerify}
      />
      {truncated.length > 0 && (
        <div className="text-xs text-amber-700 space-y-1">
          <p className="font-medium">Some isopter boundaries were not reached</p>
          <ul className="list-disc list-inside space-y-0.5 text-amber-600">
            {truncated.map(t => (
              <li key={t.stimulus}>
                {t.stimulus}: extends to <strong>at least {t.maxEccentricityReached.toFixed(0)}°</strong>{' '}
                in {t.truncatedMeridianCount} meridian{t.truncatedMeridianCount === 1 ? '' : 's'} — true
                boundary lies beyond the screen.
              </li>
            ))}
          </ul>
          <p className="text-amber-600">
            Sit closer to the screen (and recalibrate) to assess the full field.
          </p>
        </div>
      )}
      {/* Area summary */}
      <div className="grid grid-cols-2 gap-2 text-sm">
        {ISOPTER_ORDER.map(key => {
          const area = areas[key]
          if (area == null) return null
          return (
            <div key={key} className="bg-surface border border-line rounded-lg px-3 py-2 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STIMULI[key].color }} />
              <span className="text-muted">{STIMULI[key].label}</span>
              <span className="ml-auto font-mono text-ink">{area.toFixed(0)} deg²</span>
            </div>
          )
        })}
      </div>
      <ClinicalDisclaimer variant="results" />
      <Interpretation
        points={points}
        areas={areas}
        maxEccentricityDeg={maxEccentricityDeg}
        calibration={calibration}
        showReliability={showReliability}
        reliabilityIndices={reliabilityIndices}
      />
      <ScenarioOverlay userPoints={points} userAreas={areas} maxEccentricity={maxEccentricityDeg} calibration={calibration} />
      {footer}
    </main>
  )
}
