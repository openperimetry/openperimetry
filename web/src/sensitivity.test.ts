import { describe, it, expect } from 'vitest'
import {
  opacityToDb,
  dbToOpacity,
  deriveDbFromSuprathreshold,
  jetReverseColor,
  DB_MIN,
  DB_MAX,
  DB_MIN_DERIVED,
  DB_MAX_DERIVED,
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

  /** Pick the grid sample whose (meridian, eccentricity) is closest to a
   *  target location — the new function emits a whole polar grid rather
   *  than one point per input, so tests need to look up "near where the
   *  stimulus was". */
  function sampleNear(
    derived: { meridianDeg: number; eccentricityDeg: number; db: number }[],
    m: number,
    r: number,
  ): { meridianDeg: number; eccentricityDeg: number; db: number } {
    let best = derived[0]
    let bestScore = Infinity
    for (const d of derived) {
      const dm = Math.min(Math.abs(d.meridianDeg - m), 360 - Math.abs(d.meridianDeg - m))
      const dr = Math.abs(d.eccentricityDeg - r)
      const score = dm * dm + dr * dr
      if (score < bestScore) { bestScore = score; best = d }
    }
    return best
  }

  it('fills interior of the dimmest-seen isopter with the corresponding dB', () => {
    // I2e seen at (0°, 10°): every point on meridian 0 with r ≤ 10 should
    // derive to ~10 dB, not just the boundary sample. This is the main
    // behaviour change from the old per-sample bucket: the radar isopter
    // is projected inward to fill the field, so the fovea does not render
    // as an unsampled red hole.
    const pts: TestPoint[] = [
      { meridianDeg: 0, eccentricityDeg: 10, rawEccentricityDeg: 10, detected: true,  stimulus: 'V4e' },
      { meridianDeg: 0, eccentricityDeg: 10, rawEccentricityDeg: 10, detected: true,  stimulus: 'I2e' },
    ]
    const derived = deriveDbFromSuprathreshold(pts)
    expect(derived.length).toBeGreaterThan(1)
    // A point well inside the isopter (r=4°) must also be ~10 dB.
    expect(sampleNear(derived, 0, 4).db).toBeCloseTo(10, 1)
    // The centre (r=0) must also be ~10 dB — the fovea is enclosed by
    // every isopter that was ever seen, so it always inherits the
    // dimmest-seen dB. Previously the centre rendered as an unsampled
    // red hole; this is the regression guard.
    expect(sampleNear(derived, 0, 0).db).toBeCloseTo(10, 1)
  })

  it('dimmest-seen isopter wins across three intensities on the same meridian', () => {
    const pts: TestPoint[] = [
      { meridianDeg: 0, eccentricityDeg: 20, rawEccentricityDeg: 20, detected: true, stimulus: 'V4e' },   // 1.0
      { meridianDeg: 0, eccentricityDeg: 20, rawEccentricityDeg: 20, detected: true, stimulus: 'III2e' }, // 0.10
      { meridianDeg: 0, eccentricityDeg: 20, rawEccentricityDeg: 20, detected: true, stimulus: 'I4e' },   // 1.0
    ]
    const derived = deriveDbFromSuprathreshold(pts)
    // Inside the III2e isopter → 10 dB (not 0 dB, even though V4e/I4e also seen).
    expect(sampleNear(derived, 0, 10).db).toBeCloseTo(10, 1)
  })

  it('returns DB_MIN everywhere when no stimulus was detected', () => {
    const pts: TestPoint[] = [
      { meridianDeg: 90, eccentricityDeg: 25, rawEccentricityDeg: 25, detected: false, stimulus: 'V4e' },
    ]
    const derived = deriveDbFromSuprathreshold(pts)
    // Still emits a grid (the field needs rendering), just entirely at baseline.
    expect(derived.length).toBeGreaterThan(0)
    for (const d of derived) expect(d.db).toBe(DB_MIN)
  })

  it('excludes catch trials', () => {
    const pts: TestPoint[] = [
      { meridianDeg: 15, eccentricityDeg: 15, rawEccentricityDeg: 15, detected: true, stimulus: 'III4e', catchTrial: true },
    ]
    // Catch trials are the only input → no real test points → empty output.
    expect(deriveDbFromSuprathreshold(pts)).toEqual([])
  })

  it('paints outside the outermost isopter as DB_MIN baseline', () => {
    // V4e seen at (0°, 30°): inside the isopter is 0 dB (V4e = brightest
    // → lowest dB); outside is DB_MIN (nothing was detectable there).
    const pts: TestPoint[] = [
      { meridianDeg: 0, eccentricityDeg: 30, rawEccentricityDeg: 30, detected: true, stimulus: 'V4e' },
    ]
    const derived = deriveDbFromSuprathreshold(pts)
    // Inside: V4e visible → 0 dB.
    expect(sampleNear(derived, 0, 15).db).toBeCloseTo(0, 1)
    // Outside (beyond the boundary + a margin): DB_MIN.
    const outside = derived.find(d => d.eccentricityDeg > 32)
    expect(outside?.db).toBe(DB_MIN)
  })
})

describe('range constants', () => {
  it('DB_MAX > DB_MIN', () => {
    expect(DB_MAX).toBeGreaterThan(DB_MIN)
  })
  it('DB_MAX_DERIVED > DB_MIN_DERIVED', () => {
    expect(DB_MAX_DERIVED).toBeGreaterThan(DB_MIN_DERIVED)
  })
  it('derived ramp is narrower than measured ramp', () => {
    // Goldmann only spans 0–10 dB; a narrower ramp keeps those values
    // visually distinct instead of crushing them to the warm end.
    expect(DB_MAX_DERIVED - DB_MIN_DERIVED).toBeLessThan(DB_MAX - DB_MIN)
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
