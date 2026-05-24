import { describe, it, expect } from 'vitest'
import {
  generateCustomGrid,
  countCustomGridPoints,
  CUSTOM_GRID_PRESETS,
  type CustomGridParams,
} from './customGrid'

describe('generateCustomGrid', () => {
  it('produces no point on a cardinal meridian (half-spacing offset)', () => {
    const params: CustomGridParams = {
      spacingXDeg: 6,
      spacingYDeg: 6,
      extentXDeg: 24,
      extentYDeg: 24,
    }
    for (const p of generateCustomGrid(params)) {
      expect(p.xDeg).not.toBe(0)
      expect(p.yDeg).not.toBe(0)
    }
  })

  it('is quad-symmetric — every point has reflections across both axes', () => {
    const params: CustomGridParams = {
      spacingXDeg: 4,
      spacingYDeg: 4,
      extentXDeg: 20,
      extentYDeg: 20,
    }
    const points = generateCustomGrid(params)
    const keys = new Set(points.map(p => p.key))
    for (const { xDeg, yDeg } of points) {
      const mx = `${(-xDeg).toFixed(2)},${yDeg.toFixed(2)}`
      const my = `${xDeg.toFixed(2)},${(-yDeg).toFixed(2)}`
      const mxy = `${(-xDeg).toFixed(2)},${(-yDeg).toFixed(2)}`
      expect(keys.has(mx)).toBe(true)
      expect(keys.has(my)).toBe(true)
      expect(keys.has(mxy)).toBe(true)
    }
  })

  it('count matches closed-form countCustomGridPoints', () => {
    const params: CustomGridParams = {
      spacingXDeg: 6,
      spacingYDeg: 6,
      extentXDeg: 24,
      extentYDeg: 24,
    }
    const points = generateCustomGrid(params)
    expect(points.length).toBe(countCustomGridPoints(params))
    // nx = floor((24 - 3) / 6) + 1 = 4; same for ny; 4*4*4 = 64
    expect(points.length).toBe(64)
  })

  it('Screening preset is exactly 48 points at 7.5° × 6° anisotropic spacing', () => {
    const n = countCustomGridPoints(CUSTOM_GRID_PRESETS.screening)
    expect(n).toBe(48)
  })

  it('Fast preset yields a 24-2-like density (~50–70 points)', () => {
    const n = countCustomGridPoints(CUSTOM_GRID_PRESETS.fast)
    expect(n).toBeGreaterThanOrEqual(40)
    expect(n).toBeLessThanOrEqual(70)
  })

  it('Normal preset yields a 30-2-like density (~80 points)', () => {
    const n = countCustomGridPoints(CUSTOM_GRID_PRESETS.normal)
    expect(n).toBeGreaterThanOrEqual(70)
    expect(n).toBeLessThanOrEqual(150)
  })

  it('all points fall inside the requested extent', () => {
    const params: CustomGridParams = {
      spacingXDeg: 3,
      spacingYDeg: 3,
      extentXDeg: 15,
      extentYDeg: 10,
    }
    for (const p of generateCustomGrid(params)) {
      expect(Math.abs(p.xDeg)).toBeLessThanOrEqual(params.extentXDeg)
      expect(Math.abs(p.yDeg)).toBeLessThanOrEqual(params.extentYDeg)
    }
  })

  it('keys are unique — no duplicate point coordinates', () => {
    const points = generateCustomGrid(CUSTOM_GRID_PRESETS.normal)
    const keys = new Set(points.map(p => p.key))
    expect(keys.size).toBe(points.length)
  })

  it('left eye is a horizontal mirror of right eye', () => {
    const right = generateCustomGrid(CUSTOM_GRID_PRESETS.fast, 'right')
    const left = generateCustomGrid(CUSTOM_GRID_PRESETS.fast, 'left')
    expect(left.length).toBe(right.length)
    const leftKeys = new Set(left.map(p => p.key))
    for (const p of right) {
      const mirrored = `${(-p.xDeg).toFixed(2)},${p.yDeg.toFixed(2)}`
      expect(leftKeys.has(mirrored)).toBe(true)
    }
  })

  it('is deterministic — identical params produce identical output', () => {
    const a = generateCustomGrid(CUSTOM_GRID_PRESETS.normal)
    const b = generateCustomGrid(CUSTOM_GRID_PRESETS.normal)
    expect(a.map(p => p.key)).toEqual(b.map(p => p.key))
  })

  it('throws on zero or negative spacing', () => {
    expect(() =>
      generateCustomGrid({ spacingXDeg: 0, spacingYDeg: 4, extentXDeg: 24, extentYDeg: 24 }),
    ).toThrow()
    expect(() =>
      generateCustomGrid({ spacingXDeg: 4, spacingYDeg: -1, extentXDeg: 24, extentYDeg: 24 }),
    ).toThrow()
  })

  it('throws on zero or negative extent', () => {
    expect(() =>
      generateCustomGrid({ spacingXDeg: 4, spacingYDeg: 4, extentXDeg: 0, extentYDeg: 24 }),
    ).toThrow()
  })
})
