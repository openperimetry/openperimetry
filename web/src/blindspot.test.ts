import { describe, it, expect } from 'vitest'
import { blindspotLocation } from './blindspot'

describe('blindspotLocation', () => {
  it('right eye blindspot is temporal — positive x (meridian near 0°)', () => {
    const { meridianDeg, eccentricityDeg } = blindspotLocation('right')
    // Temporal for right eye is the right side of visual field (0° meridian).
    // With a 1.5° downward offset, the meridian is slightly negative
    // (below horizontal), so wrap to [-180, 180) keeping it near 0°.
    expect(Math.abs(meridianDeg)).toBeLessThan(10)
    expect(eccentricityDeg).toBeGreaterThan(14)
    expect(eccentricityDeg).toBeLessThan(17)
  })

  it('left eye blindspot is temporal — negative x (meridian near 180°)', () => {
    const { meridianDeg, eccentricityDeg } = blindspotLocation('left')
    // Temporal for left eye is the left side (180° meridian).
    expect(Math.abs(Math.abs(meridianDeg) - 180)).toBeLessThan(10)
    expect(eccentricityDeg).toBeGreaterThan(14)
    expect(eccentricityDeg).toBeLessThan(17)
  })

  it('is below horizontal (negative yDeg) for both eyes', () => {
    for (const eye of ['left', 'right'] as const) {
      const { meridianDeg, eccentricityDeg } = blindspotLocation(eye)
      const rad = (meridianDeg * Math.PI) / 180
      const yDeg = Math.sin(rad) * eccentricityDeg
      expect(yDeg).toBeLessThan(0)
    }
  })
})
