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
}

export interface TestPoint {
  meridianDeg: number
  eccentricityDeg: number   // already RT-compensated
  rawEccentricityDeg: number // before compensation
  detected: boolean
  stimulus: StimulusKey
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
  /** Elapsed time from first presented stimulus/interaction to results. */
  durationSeconds?: number
  /** Links two single-eye TestResults from the same binocular session. */
  binocularGroup?: string
}
