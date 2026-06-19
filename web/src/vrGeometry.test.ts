import { describe, it, expect } from 'vitest'
import {
  computeVrViewport,
  vrCenterBounds,
  fullScreenCenterBounds,
  rayToBoundsPx,
  vrMaxEccentricityDeg,
} from './vrGeometry'
import type { VrCalibration } from './types'

// Landscape iPhone-ish viewport. Width 812, height 375.
const W = 812
const H = 375

const vr: VrCalibration = {
  enabled: true,
  headsetPreset: 'standard',
  lensSeparationPx: 406, // = W * 0.5 → each lens center at the middle of its half
  lensCenterYOffsetPx: 0,
}

describe('computeVrViewport', () => {
  it('puts the right eye on the right half of the screen', () => {
    const vp = computeVrViewport(W, H, 'right', vr)
    expect(vp.originX).toBe(W / 2)
    expect(vp.width).toBe(W / 2)
    expect(vp.height).toBe(H)
    // Fixation sits to the RIGHT of screen center.
    expect(vp.fixationXFromScreenCenter).toBeGreaterThan(0)
    // Absolute fixation x lands inside the right half [W/2, W].
    const absX = W / 2 + vp.fixationXFromScreenCenter
    expect(absX).toBeGreaterThanOrEqual(W / 2)
    expect(absX).toBeLessThanOrEqual(W)
  })

  it('puts the left eye on the left half of the screen', () => {
    const vp = computeVrViewport(W, H, 'left', vr)
    expect(vp.originX).toBe(0)
    expect(vp.width).toBe(W / 2)
    // Fixation sits to the LEFT of screen center.
    expect(vp.fixationXFromScreenCenter).toBeLessThan(0)
    // Absolute fixation x lands inside the left half [0, W/2].
    const absX = W / 2 + vp.fixationXFromScreenCenter
    expect(absX).toBeGreaterThanOrEqual(0)
    expect(absX).toBeLessThanOrEqual(W / 2)
  })

  it('carries the vertical lens offset through to fixation', () => {
    const offsetVr: VrCalibration = { ...vr, lensCenterYOffsetPx: 24 }
    expect(computeVrViewport(W, H, 'right', offsetVr).fixationYFromScreenCenter).toBe(24)
  })
})

describe('vrCenterBounds', () => {
  it('clamps the right eye to the right half (left bound at screen center)', () => {
    const vp = computeVrViewport(W, H, 'right', vr)
    const b = vrCenterBounds(vp, W, H)
    expect(b.left).toBe(0) // screen center divides the halves
    expect(b.right).toBe(W / 2)
    expect(b.top).toBe(-H / 2)
    expect(b.bottom).toBe(H / 2)
  })

  it('clamps the left eye to the left half (right bound at screen center)', () => {
    const vp = computeVrViewport(W, H, 'left', vr)
    const b = vrCenterBounds(vp, W, H)
    expect(b.left).toBe(-W / 2)
    expect(b.right).toBe(0)
  })
})

describe('rayToBoundsPx', () => {
  it('matches full-screen geometry when given full-screen bounds', () => {
    const bounds = fullScreenCenterBounds(W, H)
    // Ray straight right from center hits the right edge at W/2.
    expect(rayToBoundsPx(0, 0, 0, bounds)).toBeCloseTo(W / 2, 6)
    // Ray straight up hits the top edge at H/2 (meridian 90°).
    expect(rayToBoundsPx(90, 0, 0, bounds)).toBeCloseTo(H / 2, 6)
  })

  it('does not let a VR stimulus cross into the other lens half', () => {
    const vp = computeVrViewport(W, H, 'right', vr)
    const bounds = vrCenterBounds(vp, W, H)
    // From the right-lens fixation, a ray pointing nasally (toward 180°,
    // i.e. toward screen center) must stop at the center divider, never
    // crossing into the left half.
    const ecc = rayToBoundsPx(180, vp.fixationXFromScreenCenter, vp.fixationYFromScreenCenter, bounds)
    const stimX = vp.fixationXFromScreenCenter - ecc // 180° points in -x
    expect(stimX).toBeGreaterThanOrEqual(bounds.left - 1e-6)
  })
})

describe('vrMaxEccentricityDeg', () => {
  it('is positive and bounded by the lens-half diagonal', () => {
    const ppd = 20
    const vp = computeVrViewport(W, H, 'right', vr)
    const maxEcc = vrMaxEccentricityDeg(vp, W, H, ppd)
    expect(maxEcc).toBeGreaterThan(0)
    // Can't exceed the half-screen diagonal in degrees.
    const diagPx = Math.hypot(W / 2, H)
    expect(maxEcc).toBeLessThanOrEqual(diagPx / ppd + 1e-6)
  })
})
