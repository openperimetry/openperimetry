import { describe, it, expect } from 'vitest'
import {
  opacityToDb,
  dbToOpacity,
  deriveDbFromSuprathreshold,
  jetReverseColor,
  DB_MIN,
  DB_MAX,
} from './sensitivity'
import type { TestPoint } from './types'

describe('opacityToDb', () => {
  it('returns 0 dB at max opacity', () => {
    expect(opacityToDb(1.0)).toBeCloseTo(0, 6)
  })
  it('returns 10 dB at 1 log unit dimmer', () => {
    expect(opacityToDb(0.1)).toBeCloseTo(10, 6)
  })
  it('is monotone: dimmer stimulus → higher dB', () => {
    expect(opacityToDb(0.5)).toBeGreaterThan(opacityToDb(1.0))
    expect(opacityToDb(0.05)).toBeGreaterThan(opacityToDb(0.5))
  })
  it('returns DB_MAX for opacity <= 0', () => {
    expect(opacityToDb(0)).toBe(DB_MAX)
    expect(opacityToDb(-0.1)).toBe(DB_MAX)
  })
  it('round-trips via dbToOpacity', () => {
    for (const op of [1.0, 0.5, 0.3, 0.1, 0.05]) {
      expect(dbToOpacity(opacityToDb(op))).toBeCloseTo(op, 6)
    }
  })
})

describe('dbToOpacity', () => {
  it('dbToOpacity guards non-finite input', () => {
    expect(dbToOpacity(NaN)).toBe(0)
    expect(dbToOpacity(-Infinity)).toBe(0)
    expect(dbToOpacity(Infinity)).toBe(0)
  })
  it('dbToOpacity clamps to [0, 1]', () => {
    // Negative dB would exceed 1 mathematically (brighter than max)
    expect(dbToOpacity(-5)).toBe(1)
  })
})

describe('deriveDbFromSuprathreshold', () => {
  it('returns empty array for no input', () => {
    expect(deriveDbFromSuprathreshold([])).toEqual([])
  })
  it('uses the dimmest seen stimulus per (meridian, ecc)', () => {
    const pts: TestPoint[] = [
      { meridianDeg: 0, eccentricityDeg: 10, rawEccentricityDeg: 10, detected: true,  stimulus: 'V4e' },
      { meridianDeg: 0, eccentricityDeg: 10, rawEccentricityDeg: 10, detected: true,  stimulus: 'I2e' },
      { meridianDeg: 0, eccentricityDeg: 10, rawEccentricityDeg: 10, detected: false, stimulus: 'I2e' },
    ]
    const derived = deriveDbFromSuprathreshold(pts)
    expect(derived).toHaveLength(1)
    // I2e intensityFrac = 0.10 → 10 dB
    expect(derived[0].db).toBeCloseTo(10, 1)
    expect(derived[0].meridianDeg).toBe(0)
    expect(derived[0].eccentricityDeg).toBe(10)
  })
  it('dimmest-seen wins across three distinct intensities', () => {
    const pts: TestPoint[] = [
      { meridianDeg: 0, eccentricityDeg: 20, rawEccentricityDeg: 20, detected: true, stimulus: 'V4e' },   // 1.0
      { meridianDeg: 0, eccentricityDeg: 20, rawEccentricityDeg: 20, detected: true, stimulus: 'III2e' }, // 0.10
      { meridianDeg: 0, eccentricityDeg: 20, rawEccentricityDeg: 20, detected: true, stimulus: 'I4e' },   // 1.0
    ]
    const [d] = deriveDbFromSuprathreshold(pts)
    // Dimmest seen is 0.10 → 10 dB (not 1.0 → 0 dB)
    expect(d.db).toBeCloseTo(10, 1)
  })
  it('returns DB_MIN when only unseen stimuli at a point', () => {
    const pts: TestPoint[] = [
      { meridianDeg: 90, eccentricityDeg: 25, rawEccentricityDeg: 25, detected: false, stimulus: 'V4e' },
    ]
    const [d] = deriveDbFromSuprathreshold(pts)
    expect(d.db).toBe(DB_MIN)
  })
  it('excludes catch trials', () => {
    const pts: TestPoint[] = [
      { meridianDeg: 15, eccentricityDeg: 15, rawEccentricityDeg: 15, detected: true, stimulus: 'III4e', catchTrial: true },
    ]
    expect(deriveDbFromSuprathreshold(pts)).toEqual([])
  })
})

describe('range constants', () => {
  it('DB_MAX > DB_MIN', () => {
    expect(DB_MAX).toBeGreaterThan(DB_MIN)
  })
})

describe('jetReverseColor', () => {
  it('low t yields the warm (red) region of jet_r', () => {
    const { r, g, b } = jetReverseColor(0)
    // jet_r at t=0 sits in the warm (red) end: red dominates, blue is 0.
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
    expect(b).toBe(0)
  })
  it('high t yields the cool (blue) region of jet_r', () => {
    const { r, g, b } = jetReverseColor(1)
    // jet_r at t=1 sits in the cool (blue) end: blue dominates, red is 0.
    expect(b).toBeGreaterThan(g)
    expect(b).toBeGreaterThan(r)
    expect(r).toBe(0)
  })
  it('clamps out-of-range t to the defined endpoints', () => {
    expect(jetReverseColor(-5)).toEqual(jetReverseColor(0))
    expect(jetReverseColor(5)).toEqual(jetReverseColor(1))
  })
  it('returns components in 0–255 range', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const { r, g, b } = jetReverseColor(t)
      for (const c of [r, g, b]) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(255)
      }
    }
  })
})
