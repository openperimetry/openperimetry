import { describe, it, expect } from 'vitest'
import { degToPx, polarDegToXY, pixelsPerCm } from './geometry'
import type { CalibrationData } from './types'

const calib: CalibrationData = {
  pixelsPerDegree: 20,
  maxEccentricityDeg: 60,
  viewingDistanceCm: 40,
  brightnessFloor: 0.1,
  reactionTimeMs: 250,
  fixationOffsetPx: 0,
}

describe('degToPx (linear, no sphericity)', () => {
  it('scales degrees by pixelsPerDegree', () => {
    expect(degToPx(10, calib)).toBeCloseTo(200, 6)
    expect(degToPx(0, calib)).toBe(0)
    expect(degToPx(-15, calib)).toBeCloseTo(-300, 6)
  })
})

describe('polarDegToXY (screen coords, y-axis inverted)', () => {
  it('places 0° meridian on the positive x-axis', () => {
    const { x, y } = polarDegToXY(0, 10, calib)
    expect(x).toBeCloseTo(200, 6)
    expect(y).toBeCloseTo(0, 6)
  })
  it('places 90° meridian above fixation (negative screen y)', () => {
    const { x, y } = polarDegToXY(90, 10, calib)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(-200, 6)
  })
})

describe('degToPx (with sphericity correction)', () => {
  // At 20 px/°, linear model → 600 px @ 30°.
  // Physical: cmPerPx = (π/180) * D / pixelsPerDegree = (π/180) * 40 / 20 ≈ 0.0349 cm/px
  // Corrected @ 30°: d = D * tan(30°) / cmPerPx
  //   = 40 * tan(30°) / 0.0349 ≈ 661.5 px
  const corrCalib = { ...calib, sphericityCorrection: true }

  it('matches linear model at 0°', () => {
    expect(degToPx(0, corrCalib)).toBe(0)
  })

  it('is nearly linear for small angles (≤5°)', () => {
    const linear = degToPx(5, calib)
    const corrected = degToPx(5, corrCalib)
    expect(Math.abs(corrected - linear) / linear).toBeLessThan(0.01)
  })

  it('expands relative to linear at large angles', () => {
    const linear30 = degToPx(30, calib)
    const corrected30 = degToPx(30, corrCalib)
    expect(corrected30).toBeGreaterThan(linear30)
    expect(corrected30).toBeCloseTo(661.5, 0)
  })

  it('is symmetric about zero', () => {
    expect(degToPx(-45, corrCalib)).toBeCloseTo(-degToPx(45, corrCalib), 6)
  })

  it('exports pixelsPerCm helper matching fovea gradient', () => {
    const ppcm = pixelsPerCm(calib)
    expect(ppcm).toBeCloseTo((20 * 180) / (Math.PI * 40), 6)
  })
})
