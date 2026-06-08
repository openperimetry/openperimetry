/**
 * HFA-style results view for static threshold tests.
 *
 * Mimics the layout of a Humphrey Field Analyzer Single Field
 * Analysis printout so the result is visually familiar to any
 * clinician the user shares it with — and so the user's own home
 * results read the same way they'd read their clinic's report.
 *
 * Honest scope: we include the elements we can render validly with
 * our (uncalibrated) home-test data — header block, threshold grid,
 * greyscale plot, and a small summary indices block (Mean dB, PSD,
 * hemifield asymmetry). We deliberately skip:
 *
 *   - Total Deviation plot
 *   - Pattern Deviation plot
 *   - MD with population P-value
 *   - VFI with age correction
 *
 * Those depend on an age-stratified normative database collected on
 * calibrated clinical bowls. Our test runs on whatever screen the
 * user has, with no luminance calibration, so a "P < 5 %"
 * probability stamp would be invented out of nothing. The bottom
 * of the page surfaces this explicitly rather than hiding it.
 *
 * The indices we DO include:
 *   - **Mean dB**: average of detected-location thresholds. Not the
 *     clinical MD (which is the deviation from age-normal) but
 *     still useful for tracking your own results over time.
 *   - **PSD**: standard deviation of the threshold map around its
 *     own mean. This one doesn't need a normative database — it's
 *     a measure of *internal* irregularity, which is exactly what
 *     PSD captures clinically too.
 *   - **Hemifield asymmetry**: difference between the mean
 *     threshold of the superior hemifield and the inferior one.
 *     Simplified version of GHT (which uses 5 paired sector
 *     clusters); enough to flag a clearly-asymmetric result without
 *     claiming a population-statistic-based label.
 */

import type { ReactNode } from 'react'
import type { TestPoint, StoredEye } from '../types'
import { SensitivityMap } from './SensitivityMap'
import { formatEyeLabelLong } from '../eyeLabels'
import type { StaticGridPattern } from '../grids'

interface Props {
  /** All test points from the run. Locations with `thresholdDb` set
   *  contribute to the threshold map, greyscale, and indices. */
  points: TestPoint[]
  eye: StoredEye
  gridPattern: StaticGridPattern
  /** ISO date string of when the test was run. */
  date?: string
  durationSeconds?: number
  /** Calibrated screen-max-brightness floor — surfaced in the
   *  header so the user can see the test's effective dynamic range. */
  brightnessFloor?: number
  /** Max measurable eccentricity (from calibration). Used by the
   *  greyscale plot's ring overlay. */
  maxEccentricityDeg: number
  /** Inter-stimulus-interval false-positive presses. Surfaced as
   *  the FP-errors row (HFA equivalent uses catch trials; we use
   *  ISI presses as the home-test analogue). */
  fpIsiPresses?: number
  /** Detected responses to real stimuli — used as the FP-rate
   *  denominator and to show "true positives" for context. */
  truePositiveResponses?: number
}

function HeaderRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between text-[13px] leading-snug">
      <span className="text-zinc-400">{label}</span>
      <span className="text-zinc-100 font-mono">{value}</span>
    </div>
  )
}

function polarToCartesian(meridianDeg: number, eccentricityDeg: number): { x: number; y: number } {
  const rad = (meridianDeg * Math.PI) / 180
  return { x: eccentricityDeg * Math.cos(rad), y: eccentricityDeg * Math.sin(rad) }
}

interface Indices {
  meanDb: number
  psd: number
  superiorMean: number | null
  inferiorMean: number | null
  /** Positive = superior brighter than inferior; negative = inferior brighter. */
  asymmetry: number | null
  hemiClass: 'within' | 'borderline' | 'outside' | 'unknown'
}

function computeIndices(points: TestPoint[]): Indices {
  const measured = points.filter(p => p.thresholdDb != null && Number.isFinite(p.thresholdDb))
  if (measured.length === 0) {
    return { meanDb: 0, psd: 0, superiorMean: null, inferiorMean: null, asymmetry: null, hemiClass: 'unknown' }
  }

  const dbValues = measured.map(p => p.thresholdDb!)
  const meanDb = dbValues.reduce((a, b) => a + b, 0) / dbValues.length
  // Population variance (we have the whole sample, not an estimate of it).
  const variance = dbValues.reduce((a, b) => a + (b - meanDb) ** 2, 0) / dbValues.length
  const psd = Math.sqrt(variance)

  // Hemifield split via the projected y coordinate. Skip points on
  // the horizontal meridian (y ≈ 0) since they don't belong to
  // either half cleanly.
  const superiorPts: number[] = []
  const inferiorPts: number[] = []
  for (const p of measured) {
    const { y } = polarToCartesian(p.meridianDeg, p.eccentricityDeg)
    if (y > 0.5) superiorPts.push(p.thresholdDb!)
    else if (y < -0.5) inferiorPts.push(p.thresholdDb!)
  }
  const superiorMean = superiorPts.length > 0
    ? superiorPts.reduce((a, b) => a + b, 0) / superiorPts.length
    : null
  const inferiorMean = inferiorPts.length > 0
    ? inferiorPts.reduce((a, b) => a + b, 0) / inferiorPts.length
    : null
  let asymmetry: number | null = null
  let hemiClass: Indices['hemiClass'] = 'unknown'
  if (superiorMean !== null && inferiorMean !== null) {
    asymmetry = superiorMean - inferiorMean
    const abs = Math.abs(asymmetry)
    // Cutoffs are intentionally simple — we don't have the
    // population data to compute proper GHT cluster comparisons,
    // so we use absolute-dB-difference thresholds as a visible-
    // asymmetry flag. < 2 dB feels like measurement noise; ≥ 4 dB
    // is a meaningful spatial pattern worth flagging.
    if (abs < 2) hemiClass = 'within'
    else if (abs < 4) hemiClass = 'borderline'
    else hemiClass = 'outside'
  }
  return { meanDb, psd, superiorMean, inferiorMean, asymmetry, hemiClass }
}

export function HFAResultsView({
  points,
  eye,
  gridPattern,
  date,
  durationSeconds,
  brightnessFloor,
  maxEccentricityDeg,
  fpIsiPresses,
  truePositiveResponses,
}: Props) {
  const measured = points.filter(p => p.thresholdDb != null && Number.isFinite(p.thresholdDb))
  const measuredDbPoints = measured.map(p => ({
    meridianDeg: p.meridianDeg,
    eccentricityDeg: p.eccentricityDeg,
    db: p.thresholdDb!,
  }))
  const indices = computeIndices(points)

  // Threshold-grid extent: snap to the data's max eccentricity with
  // a small buffer, rather than the screen's maxEccentricityDeg. The
  // grid renders just the area we actually measured, regardless of
  // what the screen could in theory reach.
  const dataExtentDeg = Math.max(1, ...measured.map(p => p.eccentricityDeg))
  const extentDeg = dataExtentDeg * 1.15

  const durationStr = durationSeconds != null
    ? `${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')}`
    : '—'

  const dateStr = date
    ? new Date(date).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : '—'

  // FP rate: ISI presses / (ISI presses + valid detections). HFA's
  // FP comes from "stimuli presented in expected-blind zones that
  // the patient responded to". Our analogue is "presses during
  // stimulus-absent ISI gaps" — different mechanism, similar
  // diagnostic role.
  let fpRateStr = '—'
  if (fpIsiPresses != null && truePositiveResponses != null) {
    const denom = fpIsiPresses + truePositiveResponses
    if (denom > 0) {
      const rate = fpIsiPresses / denom
      fpRateStr = `${(rate * 100).toFixed(0)}%`
    }
  }

  // Colour the hemifield-classification label by severity, matching
  // the GHT colour cues clinicians expect.
  const hemiClassColour =
    indices.hemiClass === 'within' ? 'text-teal' :
    indices.hemiClass === 'borderline' ? 'text-amber-400' :
    indices.hemiClass === 'outside' ? 'text-red-400' :
    'text-zinc-500'

  const hemiClassLabel =
    indices.hemiClass === 'within' ? 'Within normal limits' :
    indices.hemiClass === 'borderline' ? 'Borderline' :
    indices.hemiClass === 'outside' ? 'Outside normal limits' :
    'Insufficient data'

  return (
    <section className="space-y-4 text-left bg-zinc-950/60 rounded-2xl border border-white/[0.08] p-4 sm:p-5">
      {/* Header — eye + test type on top row, meta-grid below */}
      <header className="space-y-3 pb-3 border-b border-white/[0.08]">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-base sm:text-lg font-medium text-white">
            {formatEyeLabelLong(eye)} — Single Field Analysis
          </h2>
          <span className="text-[11px] sm:text-xs text-zinc-500 font-mono uppercase tracking-wider">
            {gridPattern === 'custom' ? 'Custom grid' : `Central ${gridPattern} Threshold Test`}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
          <HeaderRow label="Date" value={dateStr} />
          <HeaderRow label="Duration" value={durationStr} />
          <HeaderRow label="Strategy" value="4-2 dB adaptive" />
          <HeaderRow label="Stimulus" value="III, white" />
          <HeaderRow label="FP errors" value={fpRateStr} />
          {brightnessFloor != null && (
            <HeaderRow label="Screen floor" value={`${(brightnessFloor * 100).toFixed(0)}%`} />
          )}
          {/* "Test ceiling" — the highest dB the staircase can
              represent given the user's brightnessFloor calibration.
              Derivation: dB = −10·log₁₀(opacity), so the dimmest
              visible opacity (the floor) defines the highest
              measurable threshold. A floor of 0.08 caps the test
              at ~11 dB; floors of 0.01–0.04 (typical for proper
              dark-room calibration) reach 14–20 dB.

              Surfaced here so a user who scores e.g. an 11-dB plateau
              everywhere can immediately see "ah — the test's ceiling
              is 11 dB, my actual sensitivity could be much higher",
              rather than concluding their vision is uniformly poor.
              Clinical perimeters reach ~35 dB; we'll never get there
              without calibrated luminance, but knowing the home
              ceiling makes the result interpretable. */}
          {brightnessFloor != null && brightnessFloor > 0 && (
            <HeaderRow
              label="Test ceiling"
              value={`~${(-10 * Math.log10(brightnessFloor)).toFixed(0)} dB`}
            />
          )}
        </div>
      </header>

      {/* Threshold map: dB numbers laid out at their (xDeg, yDeg)
          positions, with a faint axis crosshair. Mirrors the HFA
          threshold-map block — clinicians read each cell as the
          measured threshold at that location. */}
      <div>
        <p className="text-[11px] text-zinc-400 uppercase tracking-[0.08em] mb-2">Threshold map (dB)</p>
        <div className="bg-zinc-900/60 rounded-lg border border-white/[0.04] p-3 mx-auto" style={{ maxWidth: 360 }}>
          <svg
            viewBox={`${-extentDeg} ${-extentDeg} ${extentDeg * 2} ${extentDeg * 2}`}
            className="w-full"
            style={{ aspectRatio: '1' }}
          >
            <line
              x1={-extentDeg} y1={0} x2={extentDeg} y2={0}
              stroke="rgba(255,255,255,0.18)" strokeWidth={extentDeg * 0.005}
            />
            <line
              x1={0} y1={-extentDeg} x2={0} y2={extentDeg}
              stroke="rgba(255,255,255,0.18)" strokeWidth={extentDeg * 0.005}
            />
            {measured.map((p, i) => {
              const { x, y } = polarToCartesian(p.meridianDeg, p.eccentricityDeg)
              return (
                <text
                  key={`th-${i}`}
                  x={x}
                  y={-y}
                  fontSize={extentDeg * 0.08}
                  fill="#fafafa"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontFamily="ui-monospace, 'SF Mono', monospace"
                >
                  {p.thresholdDb!.toFixed(0)}
                </text>
              )
            })}
          </svg>
        </div>
      </div>

      {/* Greyscale plot — uses the existing SensitivityMap component
          (clipped-to-data-extent + HFA greyscale conventions). The
          `dbCeiling` derived from the user's brightness-floor
          calibration normalises the colormap to their measurable
          range, so spatial variation in calibration-limited runs
          shows up instead of bunching at the dark end of a fixed
          -5 → 40 dB scale. */}
      <div>
        <p className="text-[11px] text-zinc-400 uppercase tracking-[0.08em] mb-2">Greyscale plot</p>
        <SensitivityMap
          points={measuredDbPoints}
          eye={eye}
          maxEccentricity={maxEccentricityDeg}
          size={Math.min(360, typeof window !== 'undefined' ? window.innerWidth - 80 : 360)}
          dbCeiling={brightnessFloor != null && brightnessFloor > 0
            ? -10 * Math.log10(brightnessFloor)
            : undefined}
        />
      </div>

      {/* Summary indices */}
      <div className="space-y-1.5 border-t border-white/[0.08] pt-3">
        <p className="text-[11px] text-zinc-400 uppercase tracking-[0.08em] mb-1">Summary indices</p>
        <HeaderRow label="Mean dB" value={`${indices.meanDb.toFixed(1)} dB`} />
        <HeaderRow label="PSD (threshold spread)" value={`${indices.psd.toFixed(1)} dB`} />
        {indices.asymmetry !== null && (
          <>
            <HeaderRow
              label="Hemifield Δ (S − I)"
              value={`${indices.asymmetry > 0 ? '+' : ''}${indices.asymmetry.toFixed(1)} dB`}
            />
            <div className="flex justify-between text-[13px] leading-snug">
              <span className="text-zinc-400">Asymmetry</span>
              <span className={hemiClassColour}>{hemiClassLabel}</span>
            </div>
          </>
        )}
      </div>

      {/* Total/Pattern-Deviation caveat used to live here. Removed
          per user request — the message was honest but a bit much
          to read on every result. The same caveat content is still
          useful elsewhere (Methods page, Help) but not as a
          per-result banner. */}
    </section>
  )
}
