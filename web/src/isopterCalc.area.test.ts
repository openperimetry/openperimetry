import { describe, it, expect } from 'vitest'
import { calcIsopterAreas } from './isopterCalc'
import type { StimulusKey, TestPoint } from './types'

// A full ring of detected points at constant eccentricity → the isopter area
// should approximate the spherical solid angle Ω = 2π(1−cosρ)·(180/π)², and be
// strictly less than the flat-polygon value π·ρ² (the old shoelace).
function ring(stimulus: StimulusKey, eccDeg: number, n = 24): TestPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    meridianDeg: (i * 360) / n,
    eccentricityDeg: eccDeg,
    rawEccentricityDeg: eccDeg,
    detected: true,
    stimulus,
  }))
}

describe('calcIsopterAreas — spherical solid angle', () => {
  it('matches the spherical formula and undershoots the flat polygon at 30°', () => {
    const ecc = 30
    const areas = calcIsopterAreas(ring('V4e', ecc))
    const got = areas.V4e as number

    const rho = (ecc * Math.PI) / 180
    const spherical = 2 * Math.PI * (1 - Math.cos(rho)) * (180 / Math.PI) ** 2
    const flat = Math.PI * ecc * ecc

    expect(got).toBeGreaterThan(0)
    expect(got).toBeCloseTo(spherical, 0) // within ~1 deg²
    expect(got).toBeLessThan(flat) // spherical is smaller than the old shoelace
  })

  it('reduces to ~flat for small isopters (5°)', () => {
    const ecc = 5
    const got = calcIsopterAreas(ring('I2e', ecc)).I2e as number
    const flat = Math.PI * ecc * ecc
    // Difference is <0.2% at 5°, so the two are effectively equal here.
    expect(got).toBeCloseTo(flat, 0)
  })
})
