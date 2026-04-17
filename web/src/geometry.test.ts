import { describe, it, expect } from 'vitest'
import { degToPx, polarDegToXY, pixelsPerCm } from './geometry'
import type { CalibrationData } from './types'

// Base calibration used by small-angle tests. `sphericityCorrection: false`
// is set explicitly because the runtime default is now true — we want
// the linear branch only when the caller asks for it.
const linearCalib: CalibrationData = {
  pixelsPerDegree: 20,
  maxEccentricityDeg: 60,
  viewingDistanceCm: 40,
  brightnessFloor: 0.1,
  reactionTimeMs: 250,
  fixationOffsetPx: 0,
  sphericityCorrection: false,
}

describe('degToPx with sphericityCorrection: false (linear)', () => {
  it('scales degrees by pixelsPerDegree', () => {
    expect(degToPx(10, linearCalib)).toBeCloseTo(200, 6)
    expect(degToPx(0, linearCalib)).toBe(0)
    expect(degToPx(-15, linearCalib)).toBeCloseTo(-300, 6)
  })
})

describe('polarDegToXY (linear calib, screen coords, y-axis inverted)', () => {
  it('places 0° meridian on the positive x-axis', () => {
    const { x, y } = polarDegToXY(0, 10, linearCalib)
    expect(x).toBeCloseTo(200, 6)
    expect(y).toBeCloseTo(0, 6)
  })
  it('places 90° meridian above fixation (negative screen y)', () => {
    const { x, y } = polarDegToXY(90, 10, linearCalib)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(-200, 6)
  })
})

describe('degToPx with sphericity correction (default)', () => {
  // At 20 px/°, linear model → 600 px @ 30°.
  // Physical: cmPerPx = (π/180) * D / pixelsPerDegree = (π/180) * 40 / 20 ≈ 0.0349 cm/px
  // Corrected @ 30°: d = D * tan(30°) / cmPerPx
  //   = 40 * tan(30°) / 0.0349 ≈ 661.5 px
  const corrCalib: CalibrationData = { ...linearCalib, sphericityCorrection: true }

  it('matches linear model at 0°', () => {
    expect(degToPx(0, corrCalib)).toBe(0)
  })

  it('is nearly linear for small angles (≤5°)', () => {
    const linear = degToPx(5, linearCalib)
    const corrected = degToPx(5, corrCalib)
    expect(Math.abs(corrected - linear) / linear).toBeLessThan(0.01)
  })

  it('expands relative to linear at large angles', () => {
    const linear30 = degToPx(30, linearCalib)
    const corrected30 = degToPx(30, corrCalib)
    expect(corrected30).toBeGreaterThan(linear30)
    expect(corrected30).toBeCloseTo(661.5, 0)
  })

  it('is symmetric about zero', () => {
    expect(degToPx(-45, corrCalib)).toBeCloseTo(-degToPx(45, corrCalib), 6)
  })

  it('exports pixelsPerCm helper matching fovea gradient', () => {
    const ppcm = pixelsPerCm(linearCalib)
    expect(ppcm).toBeCloseTo((20 * 180) / (Math.PI * 40), 6)
  })

  it('applies sphericity correction when field is unset (new default)', () => {
    const bareCalib: CalibrationData = {
      pixelsPerDegree: 20,
      maxEccentricityDeg: 60,
      viewingDistanceCm: 40,
      brightnessFloor: 0.1,
      reactionTimeMs: 250,
      fixationOffsetPx: 0,
    }
    // At 30°, corrected value should be ~661.5 px, clearly above the 600 px
    // that the linear approximation would give.
    expect(degToPx(30, bareCalib)).toBeCloseTo(661.5, 0)
  })
})
