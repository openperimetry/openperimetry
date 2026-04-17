export type Eye = 'left' | 'right' | 'both'

export type StimulusKey = 'V4e' | 'III4e' | 'III2e' | 'I4e' | 'I2e'

export interface StimulusDef {
  key: StimulusKey
  label: string
  sizeDeg: number        // angular diameter in degrees
  intensityFrac: number  // 1.0 = max brightness, 0.3 = 1 log unit dimmer, etc.
  color: string          // isopter color on map
}

export const STIMULI: Record<StimulusKey, StimulusDef> = {
  'V4e':   { key: 'V4e',   label: 'V4e',   sizeDeg: 1.73, intensityFrac: 1.0,   color: '#60a5fa' },
  'III4e': { key: 'III4e', label: 'III4e', sizeDeg: 0.43, intensityFrac: 1.0,   color: '#34d399' },
  'III2e': { key: 'III2e', label: 'III2e', sizeDeg: 0.43, intensityFrac: 0.10,  color: '#a78bfa' },
  'I4e':   { key: 'I4e',   label: 'I4e',   sizeDeg: 0.11, intensityFrac: 1.0,   color: '#fb923c' },
  'I2e':   { key: 'I2e',   label: 'I2e',   sizeDeg: 0.11, intensityFrac: 0.10,  color: '#f472b6' },
}

/** Order from outermost (brightest/largest) to innermost */
export const ISOPTER_ORDER: StimulusKey[] = ['V4e', 'III4e', 'III2e', 'I4e', 'I2e']

export interface CalibrationData {
  pixelsPerDegree: number
  maxEccentricityDeg: number
  viewingDistanceCm: number
  brightnessFloor: number   // minimum visible opacity (0–1)
  reactionTimeMs: number    // measured reaction time for RT compensation
  fixationOffsetPx: number  // horizontal fixation offset from screen center (positive = right)
  screenWidthPx?: number    // screen width at test time (for accurate boundary rendering)
  screenHeightPx?: number   // screen height at test time
  /** Flat-screen sphericity correction: when unset or true, `degToPx`
   *  uses `offset_cm = D * tan(θ)` so peripheral points project
   *  accurately on a flat monitor. Set to `false` to opt into the
   *  small-angle linear approximation (`deg * pixelsPerDegree`), which
   *  matches SPECVIS's single-scalar px/deg but under-projects past
   *  ~20° of eccentricity. */
  sphericityCorrection?: boolean
}

export interface TestPoint {
  meridianDeg: number
  eccentricityDeg: number   // already RT-compensated
  rawEccentricityDeg: number // before compensation
  detected: boolean
  stimulus: StimulusKey
  /** If true, this presentation was a blindspot catch trial, not a real
   *  sensitivity probe. A `detected: true` catch trial is a fixation-loss
   *  signal (false positive). Catch trials are excluded from isopter and
   *  area calculations. Omitted/undefined means a normal probe. */
  catchTrial?: boolean
  /** Measured threshold in dB at this location (threshold-mode only).
   *  Omitted on suprathreshold points; consumers MUST treat this as
   *  optional. Populated by the 4-2 staircase engine (`staircase.ts`)
   *  when `TestResult.testMode === 'threshold'`. */
  thresholdDb?: number
}

export type TestType = 'goldmann' | 'ring' | 'static'

/** Stored test results are always single-eye. Binocular sessions are stored
 *  as TWO TestResults (one per eye) sharing a binocularGroup UUID. The UI
 *  regroups them by that ID at display time. */
export type StoredEye = 'left' | 'right'

export interface TestResult {
  id: string
  eye: StoredEye
  date: string
  points: TestPoint[]
  isopterAreas: Partial<Record<StimulusKey, number>>
  calibration: CalibrationData
  testType?: TestType
  /** Test presentation mode:
   *  - `'suprathreshold'` — Goldmann-level sweep (V4e → I2e), yields isopters.
   *     Same as the default flow; omitted on results recorded before the
   *     threshold mode shipped.
   *  - `'threshold'` — per-location 4-2 dB staircase with stimulus III.
   *     Yields `thresholdDb` on every TestPoint. No isopters produced;
   *     `isopterAreas` is left empty. */
  testMode?: 'suprathreshold' | 'threshold'
  /** Elapsed time from first presented stimulus/interaction to results. */
  durationSeconds?: number
  /** Links two single-eye TestResults from the same binocular session. */
  binocularGroup?: string
  /** Reliability Indices recorded during the test, following the nomenclature
   *  of Dzwiniel et al. 2017 (PLoS ONE 12(10):e0186224).
   *
   *  Omitted on test results recorded before these metrics were implemented
   *  (pre-2026-04). Consumers MUST treat the whole field as optional.
   *
   *  Derived metrics (computed at display time, NOT stored here):
   *    FA (%)   = (catchTrialsPresented - catchTrialsFalsePositive)
   *               / catchTrialsPresented × 100
   *             — normal range 79–99 % in healthy controls (Dzwiniel 2017, n=21)
   *    FPRR (%) = (catchTrialsFalsePositive + falsePositiveIsiPresses)
   *               / (catchTrialsFalsePositive + falsePositiveIsiPresses
   *                  + truePositiveResponses) × 100
   *             — normal range 0.3–2.3 % in healthy controls (Dzwiniel 2017) */
  reliabilityIndices?: {
    /** Number of blindspot catch trials presented during the test. */
    catchTrialsPresented: number
    /** Catch trials the patient reported seeing (fixation-loss signal). */
    catchTrialsFalsePositive: number
    /** Key presses during stimulus-absent ISI windows (trigger-happy signal).
     *  Measured separately from catch trials; contributes to FPRR numerator. */
    falsePositiveIsiPresses: number
    /** Valid detections on real (non-catch) stimulus presentations.
     *  FPRR denominator uses (catchTrialsFalsePositive + falsePositiveIsiPresses
     *  + truePositiveResponses). */
    truePositiveResponses: number
  }
}
