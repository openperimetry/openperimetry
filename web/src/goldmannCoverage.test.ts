import { describe, it, expect } from 'vitest'
import { detectTruncatedIsopters } from './goldmannCoverage'
import type { TestPoint } from './types'

function pt(
  stimulus: TestPoint['stimulus'],
  meridianDeg: number,
  eccentricityDeg: number,
  detected: boolean,
): TestPoint {
  return {
    stimulus,
    meridianDeg,
    eccentricityDeg,
    rawEccentricityDeg: eccentricityDeg,
    detected,
  } as TestPoint
}

describe('detectTruncatedIsopters', () => {
  it('flags an edge-pinned meridian with no miss beyond it', () => {
    // Sanity / characterisation: a hit hugging the reachable edge (>= 30 - 2)
    // with no miss further out is a genuine truncation.
    const points = [pt('V4e', 90, 29, true)]
    const result = detectTruncatedIsopters(points, 30)
    expect(result).toEqual([
      { stimulus: 'V4e', truncatedMeridianCount: 1, maxEccentricityReached: 29 },
    ])
  })

  it('does not split the 0° direction across a phantom 360° bin', () => {
    // Regression for the meridian-bin wrap bug: round(359/5)*5 = 360, a
    // distinct bucket from bin 0, so a hit at 359° and the miss just beyond
    // it at 1° (the SAME physical direction) landed in different buckets and
    // the meridian was wrongly reported as truncated. The miss at 29.5°
    // (> the 29° hit) anchors the real boundary, so it is NOT truncated.
    const points = [
      pt('V4e', 359, 29, true),
      pt('V4e', 1, 29.5, false),
    ]
    const result = detectTruncatedIsopters(points, 30)
    expect(result).toEqual([])
  })
})
