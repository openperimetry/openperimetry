import { describe, it, expect } from 'vitest'
import { exportToOvfx, importFromOvfx } from './ovfx'
import type { CalibrationData, TestPoint, TestResult } from './types'

// ── Minimal fixtures ────────────────────────────────────────────────────────

const baseCal: CalibrationData = {
  pixelsPerDegree: 12,
  maxEccentricityDeg: 70,
  viewingDistanceCm: 50,
  brightnessFloor: 0.04,
  reactionTimeMs: 250,
  fixationOffsetPx: -200,
  screenWidthPx: 1920,
  screenHeightPx: 1080,
}

function makePoint(overrides: Partial<TestPoint> = {}): TestPoint {
  return {
    meridianDeg: 0,
    eccentricityDeg: 60,
    rawEccentricityDeg: 60,
    detected: true,
    stimulus: 'V4e',
    ...overrides,
  }
}

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'test-uuid-001',
    eye: 'right',
    date: '2026-04-16T10:00:00Z',
    points: [makePoint()],
    isopterAreas: {},
    calibration: baseCal,
    testType: 'goldmann',
    ...overrides,
  }
}

// ── Round-trip tests ────────────────────────────────────────────────────────

describe('OVFX round-trip: catchTrial and reliabilityIndices', () => {
  it('exports and imports a catch-trial point with all fields intact', () => {
    const catchPoint = makePoint({
      meridianDeg: 195,
      eccentricityDeg: 14.5,
      rawEccentricityDeg: 14.5,
      detected: false,
      catchTrial: true,
    })
    const normalPoint = makePoint({ meridianDeg: 30, eccentricityDeg: 65, rawEccentricityDeg: 65 })

    const result = makeResult({
      testType: 'static',
      points: [normalPoint, catchPoint],
      reliabilityIndices: {
        catchTrialsPresented: 10,
        catchTrialsFalsePositive: 1,
        falsePositiveIsiPresses: 2,
        truePositiveResponses: 87,
      },
    })

    const doc = exportToOvfx(result)

    // Verify doc shape
    expect(doc.ovfxVersion).toBe('0.4.0')
    expect(doc.points).toHaveLength(2)

    const exportedCatch = doc.points.find((p) => p.catchTrial === true)
    expect(exportedCatch).toBeDefined()
    expect(exportedCatch?.meridianDeg).toBe(195)
    expect(exportedCatch?.detected).toBe(false)

    const exportedNormal = doc.points.find((p) => !p.catchTrial)
    expect(exportedNormal?.catchTrial).toBeUndefined() // not emitted when falsy

    expect(doc.reliabilityIndices).toEqual({
      catchTrialsPresented: 10,
      catchTrialsFalsePositive: 1,
      falsePositiveIsiPresses: 2,
      truePositiveResponses: 87,
    })

    // Round-trip through import
    const imported = importFromOvfx(doc)

    const importedCatch = imported.points.find((p) => p.catchTrial === true)
    expect(importedCatch).toBeDefined()
    expect(importedCatch?.meridianDeg).toBe(195)
    expect(importedCatch?.detected).toBe(false)
    expect(importedCatch?.catchTrial).toBe(true)

    const importedNormal = imported.points.find((p) => !p.catchTrial)
    expect(importedNormal?.catchTrial).toBeUndefined()

    expect(imported.reliabilityIndices).toEqual({
      catchTrialsPresented: 10,
      catchTrialsFalsePositive: 1,
      falsePositiveIsiPresses: 2,
      truePositiveResponses: 87,
    })
  })

  it('does not emit catchTrial or reliabilityIndices when absent on the result', () => {
    const result = makeResult({
      points: [makePoint()],
      // no reliabilityIndices
    })

    const doc = exportToOvfx(result)

    expect(doc.reliabilityIndices).toBeUndefined()
    expect(doc.points[0].catchTrial).toBeUndefined()

    const imported = importFromOvfx(doc)
    expect(imported.reliabilityIndices).toBeUndefined()
    expect(imported.points[0].catchTrial).toBeUndefined()
  })

  it('emits reliabilityIndices with all-zero counts when present', () => {
    const result = makeResult({
      reliabilityIndices: {
        catchTrialsPresented: 0,
        catchTrialsFalsePositive: 0,
        falsePositiveIsiPresses: 0,
        truePositiveResponses: 0,
      },
    })

    const doc = exportToOvfx(result)
    expect(doc.reliabilityIndices).toEqual({
      catchTrialsPresented: 0,
      catchTrialsFalsePositive: 0,
      falsePositiveIsiPresses: 0,
      truePositiveResponses: 0,
    })

    const imported = importFromOvfx(doc)
    expect(imported.reliabilityIndices).toEqual({
      catchTrialsPresented: 0,
      catchTrialsFalsePositive: 0,
      falsePositiveIsiPresses: 0,
      truePositiveResponses: 0,
    })
  })

  it('round-trips thresholdDb + testMode for threshold-mode results', () => {
    const result = makeResult({
      testType: 'static',
      testMode: 'threshold',
      points: [
        makePoint({ meridianDeg: 30, eccentricityDeg: 10, rawEccentricityDeg: 10, stimulus: 'III4e', thresholdDb: 28 }),
        makePoint({ meridianDeg: 210, eccentricityDeg: 15, rawEccentricityDeg: 15, stimulus: 'III4e', thresholdDb: 14 }),
      ],
    })

    const doc = exportToOvfx(result)
    expect(doc.test.strategy).toBe('threshold')
    expect(doc.points[0].sensitivityDb).toBe(28)
    expect(doc.points[1].sensitivityDb).toBe(14)

    const imported = importFromOvfx(doc)
    expect(imported.testMode).toBe('threshold')
    expect(imported.points[0].thresholdDb).toBe(28)
    expect(imported.points[1].thresholdDb).toBe(14)
  })

  it('marks static imports as suprathreshold when no sensitivityDb is present', () => {
    const result = makeResult({
      testType: 'static',
      testMode: 'suprathreshold',
      points: [makePoint({ stimulus: 'III4e' })],
    })

    const doc = exportToOvfx(result)
    expect(doc.test.strategy).toBe('suprathreshold')
    expect(doc.points[0].sensitivityDb).toBeUndefined()

    const imported = importFromOvfx(doc)
    expect(imported.testMode).toBe('suprathreshold')
    expect(imported.points[0].thresholdDb).toBeUndefined()
  })

  it('does not set testMode for non-static test types', () => {
    const result = makeResult({ testType: 'goldmann' })
    const doc = exportToOvfx(result)
    const imported = importFromOvfx(doc)
    expect(imported.testMode).toBeUndefined()
  })

  it('multiple catch-trial points all round-trip correctly', () => {
    const points = [
      makePoint({ meridianDeg: 30, eccentricityDeg: 65, rawEccentricityDeg: 65 }),
      makePoint({ meridianDeg: 195, eccentricityDeg: 14.5, rawEccentricityDeg: 14.5, detected: false, catchTrial: true }),
      makePoint({ meridianDeg: 195, eccentricityDeg: 14.5, rawEccentricityDeg: 14.5, detected: true,  catchTrial: true }),
    ]

    const result = makeResult({ testType: 'static', points })
    const doc = exportToOvfx(result)
    const imported = importFromOvfx(doc)

    const catchPoints = imported.points.filter((p) => p.catchTrial === true)
    expect(catchPoints).toHaveLength(2)
    const normalPoints = imported.points.filter((p) => !p.catchTrial)
    expect(normalPoints).toHaveLength(1)
  })
})
