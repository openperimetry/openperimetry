import { describe, it, expect } from 'vitest'
import { aggregatePerPoint } from './perResultAggregation'
import type { TestResult, TestPoint, TestType } from './types'

function makeResult(
  id: string,
  detections: Array<[number, number, boolean]>,
  opts: { testType?: TestType; catchTrialAt?: Array<[number, number]> } = {},
): TestResult {
  const points: TestPoint[] = detections.map(([meridianDeg, eccentricityDeg, detected]) => ({
    meridianDeg,
    eccentricityDeg,
    rawEccentricityDeg: eccentricityDeg,
    detected,
    stimulus: 'III4e',
    catchTrial: opts.catchTrialAt?.some(
      ([m, e]) => m === meridianDeg && e === eccentricityDeg,
    )
      ? true
      : undefined,
  }))
  return {
    id,
    eye: 'right',
    date: '2026-04-17T00:00:00Z',
    points,
    isopterAreas: {},
    calibration: {
      pixelsPerDegree: 20,
      maxEccentricityDeg: 60,
      viewingDistanceCm: 33,
      brightnessFloor: 0,
      reactionTimeMs: 300,
      fixationOffsetPx: 0,
    },
    testType: opts.testType ?? 'static',
  }
}

describe('aggregatePerPoint', () => {
  it('returns zero SD for a single result (n=1 at every point)', () => {
    const r = makeResult('a', [
      [0, 10, true],
      [90, 10, false],
    ])
    const agg = aggregatePerPoint([r])
    expect(agg.get('0,10')?.stdev).toBe(0)
    expect(agg.get('0,10')?.mean).toBe(1)
    expect(agg.get('0,10')?.n).toBe(1)
    expect(agg.get('90,10')?.stdev).toBe(0)
    expect(agg.get('90,10')?.mean).toBe(0)
    expect(agg.get('90,10')?.n).toBe(1)
  })

  it('returns SD 0 and mean = pattern for two identical results', () => {
    const a = makeResult('a', [
      [0, 10, true],
      [90, 10, false],
    ])
    const b = makeResult('b', [
      [0, 10, true],
      [90, 10, false],
    ])
    const agg = aggregatePerPoint([a, b])
    expect(agg.get('0,10')?.mean).toBe(1)
    expect(agg.get('0,10')?.stdev).toBe(0)
    expect(agg.get('0,10')?.n).toBe(2)
    expect(agg.get('90,10')?.mean).toBe(0)
    expect(agg.get('90,10')?.stdev).toBe(0)
    expect(agg.get('90,10')?.n).toBe(2)
  })

  it('computes mean 0.5 and population SD 0.5 for two results disagreeing on one point', () => {
    const a = makeResult('a', [[0, 10, true]])
    const b = makeResult('b', [[0, 10, false]])
    const agg = aggregatePerPoint([a, b])
    expect(agg.get('0,10')?.mean).toBeCloseTo(0.5)
    expect(agg.get('0,10')?.stdev).toBeCloseTo(0.5)
    expect(agg.get('0,10')?.n).toBe(2)
  })

  it('rounds keys to 1 decimal place', () => {
    const r = makeResult('a', [
      [0.04, 10.05, true], // should round to "0,10.1"
    ])
    const agg = aggregatePerPoint([r])
    // 0.04 → "0" (rounded to 1 decimal is 0.0 → stringified as "0"),
    // 10.05 → "10.1"
    expect(agg.has('0,10.1')).toBe(true)
  })

  it('includes points seen in only some results (n reflects coverage)', () => {
    // Point (0, 10) present in both; (90, 10) present only in a.
    const a = makeResult('a', [
      [0, 10, true],
      [90, 10, true],
    ])
    const b = makeResult('b', [[0, 10, false]])
    const agg = aggregatePerPoint([a, b])
    expect(agg.get('0,10')?.n).toBe(2)
    expect(agg.get('90,10')?.n).toBe(1)
    expect(agg.get('90,10')?.mean).toBe(1)
    expect(agg.get('90,10')?.stdev).toBe(0)
  })

  it('excludes catch-trial points from aggregation', () => {
    // Catch trial at (0, 15) should NOT appear in aggregation — it's a
    // fixation-loss probe, not a sensitivity measurement.
    const r = makeResult(
      'a',
      [
        [0, 10, true],
        [0, 15, true], // catch-trial false positive
      ],
      { catchTrialAt: [[0, 15]] },
    )
    const agg = aggregatePerPoint([r])
    expect(agg.has('0,10')).toBe(true)
    expect(agg.has('0,15')).toBe(false)
  })

  it('throws when aggregating across mismatched test types', () => {
    const a = makeResult('a', [[0, 10, true]], { testType: 'static' })
    const b = makeResult('b', [[0, 10, true]], { testType: 'goldmann' })
    expect(() => aggregatePerPoint([a, b])).toThrow(/test type/i)
  })

  it('returns an empty map when called with no results', () => {
    const agg = aggregatePerPoint([])
    expect(agg.size).toBe(0)
  })
})
