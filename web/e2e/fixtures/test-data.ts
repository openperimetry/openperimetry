import type { TestResult, TestPoint, CalibrationData, StimulusKey } from '../../src/types'

function makePoints(): TestPoint[] {
  const meridians = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]
  const stimuli: StimulusKey[] = ['V4e', 'III4e', 'I4e']
  const points: TestPoint[] = []

  for (const stimulus of stimuli) {
    const baseEcc = stimulus === 'V4e' ? 50 : stimulus === 'III4e' ? 35 : 20
    for (const m of meridians) {
      const ecc = baseEcc + (Math.random() - 0.5) * 10
      points.push({
        meridianDeg: m,
        eccentricityDeg: ecc,
        rawEccentricityDeg: ecc + 2,
        detected: true,
        stimulus,
      })
    }
  }
  return points
}

function makeCalibration(): CalibrationData {
  return {
    pixelsPerDegree: 10,
    maxEccentricityDeg: 60,
    viewingDistanceCm: 50,
    brightnessFloor: 0.04,
    reactionTimeMs: 280,
    fixationOffsetPx: -200,
    screenWidthPx: 1920,
    screenHeightPx: 1080,
  }
}

export function createTestResult(overrides: Partial<TestResult> = {}): TestResult {
  const eye = overrides.eye ?? 'right'
  const points = overrides.points ?? makePoints()
  return {
    id: crypto.randomUUID(),
    eye,
    date: new Date().toISOString(),
    points,
    isopterAreas: {
      'V4e': 8200,
      'III4e': 3800,
      'I4e': 1200,
    },
    calibration: makeCalibration(),
    testType: 'goldmann',
    ...overrides,
  }
}

export function createResultPair(): TestResult[] {
  return [
    createTestResult({ eye: 'right', date: new Date(Date.now() - 86400000).toISOString() }),
    createTestResult({ eye: 'left', date: new Date().toISOString() }),
  ]
}
