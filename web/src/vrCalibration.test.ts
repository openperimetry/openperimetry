import { describe, it, expect } from 'vitest'
import { vrDefaultLensSeparationFraction } from './vrCalibration'

describe('vrDefaultLensSeparationFraction', () => {
  it('derives separation from IPD and clamps to the slider range', () => {
    // IPD 62 mm at 6 px/mm = 372 px; on an 812 px viewport that is ~0.46.
    const frac = vrDefaultLensSeparationFraction('standard', 6, 812)
    expect(frac).toBeCloseTo((62 * 6) / 812, 6)
    expect(frac).toBeGreaterThanOrEqual(0.3)
    expect(frac).toBeLessThanOrEqual(0.9)
  })

  it('falls back to the neutral default when inputs are not measured', () => {
    expect(vrDefaultLensSeparationFraction('standard', 0, 812)).toBe(0.5)
  })
})
