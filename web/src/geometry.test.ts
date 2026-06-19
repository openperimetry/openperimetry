import { describe, it, expect } from 'vitest'
import { degToPx, pxToDeg, polarDegToXY, pixelsPerCm, reprojectPolar } from './geometry'
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

  it('pxToDeg is the exact inverse of degToPx (corrected + linear)', () => {
    const corrCalib2: CalibrationData = { ...linearCalib, sphericityCorrection: true }
    for (const deg of [0, 5, 20, 45, 60]) {
      expect(pxToDeg(degToPx(deg, corrCalib2), corrCalib2)).toBeCloseTo(deg, 6)
      expect(pxToDeg(degToPx(deg, linearCalib), linearCalib)).toBeCloseTo(deg, 6)
    }
  })

  it('pxToDeg under-reports the linear px/ppd shortcut at large VR-like angles', () => {
    // Phone-VR-ish: tiny focal-length px/deg, short optical distance. A large
    // edge distance should map to far fewer degrees than the linear px/ppd
    // shortcut would claim — the bug this replaces.
    const vrCalib: CalibrationData = {
      pixelsPerDegree: 4.68,
      maxEccentricityDeg: 47,
      viewingDistanceCm: 4.2,
      brightnessFloor: 0.075,
      reactionTimeMs: 250,
      fixationOffsetPx: 0,
      sphericityCorrection: true,
    }
    const edgePx = 218 // ~lens-half temporal edge
    const linearDeg = edgePx / vrCalib.pixelsPerDegree
    const trueDeg = pxToDeg(edgePx, vrCalib)
    expect(trueDeg).toBeLessThan(linearDeg)
    // And it round-trips with degToPx at that distance.
    expect(degToPx(trueDeg, vrCalib)).toBeCloseTo(edgePx, 4)
  })

  it('reprojectPolar is the identity when the two fixations coincide', () => {
    const c: CalibrationData = { ...linearCalib, sphericityCorrection: true }
    const f = { x: 30, y: -10 }
    for (const [m, e] of [[0, 10], [90, 20], [200, 35], [330, 5]]) {
      const r = reprojectPolar(m, e, f, f, c)
      expect(r.eccentricityDeg).toBeCloseTo(e, 4)
      expect(r.meridianDeg).toBeCloseTo(m, 4)
    }
  })

  it('reprojectPolar moves a shifted-fixation point to its true centered eccentricity', () => {
    const c: CalibrationData = { ...linearCalib, sphericityCorrection: true }
    const center = { x: 0, y: 0 }
    // Fixation parked one degree-equivalent below center (y grows down).
    const below = { x: 0, y: degToPx(8, c) }
    // A point recorded AT the shifted fixation (ecc 0) is really 8° below center
    // → meridian 270 (down), ecc 8.
    const atFix = reprojectPolar(0, 0, below, center, c)
    expect(atFix.eccentricityDeg).toBeCloseTo(8, 3)
    expect(atFix.meridianDeg).toBeCloseTo(270, 3)
    // A point 8° straight UP from the shifted (below-center) fixation lands back
    // at center → ecc ~0.
    const up = reprojectPolar(90, 8, below, center, c)
    expect(up.eccentricityDeg).toBeCloseTo(0, 3)
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
