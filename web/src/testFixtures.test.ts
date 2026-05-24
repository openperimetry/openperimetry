import { describe, it, expect } from 'vitest'
import {
  SCENARIO_PROFILES,
  makeStaticThresholdPoints,
  getAllScenarios,
} from './testFixtures'

describe('makeStaticThresholdPoints', () => {
  it("returns one point per 24-2 grid location (54)", () => {
    const pts = makeStaticThresholdPoints(SCENARIO_PROFILES.normal)
    expect(pts.length).toBe(54)
  })

  it('populates thresholdDb in the normal [0, 40] range with detected=true', () => {
    const pts = makeStaticThresholdPoints(SCENARIO_PROFILES.normal)
    for (const p of pts) {
      expect(p.thresholdDb).toBeDefined()
      expect(p.thresholdDb!).toBeGreaterThanOrEqual(0)
      expect(p.thresholdDb!).toBeLessThanOrEqual(40)
      expect(p.detected).toBe(true)
      expect(p.stimulus).toBe('III4e')
    }
  })

  it('is deterministic — same profile yields the same dB values', () => {
    const a = makeStaticThresholdPoints(SCENARIO_PROFILES.normal)
    const b = makeStaticThresholdPoints(SCENARIO_PROFILES.normal)
    expect(a.map(p => p.thresholdDb)).toEqual(b.map(p => p.thresholdDb))
  })

  it('normal profile has noticeably higher mean dB than severeRP', () => {
    const normal = makeStaticThresholdPoints(SCENARIO_PROFILES.normal)
    const severe = makeStaticThresholdPoints(SCENARIO_PROFILES.severeRP)
    const mean = (arr: typeof normal) =>
      arr.reduce((s, p) => s + (p.thresholdDb ?? 0), 0) / arr.length
    expect(mean(normal)).toBeGreaterThan(mean(severe) + 5)
  })

  it('severity order matches expected progression', () => {
    const mean = (profile: keyof typeof SCENARIO_PROFILES) => {
      const pts = makeStaticThresholdPoints(SCENARIO_PROFILES[profile])
      return pts.reduce((s, p) => s + (p.thresholdDb ?? 0), 0) / pts.length
    }
    expect(mean('normal')).toBeGreaterThan(mean('earlyRP'))
    expect(mean('earlyRP')).toBeGreaterThan(mean('moderateRP'))
    expect(mean('moderateRP')).toBeGreaterThan(mean('severeRP'))
    expect(mean('severeRP')).toBeGreaterThan(mean('verySevereRP'))
  })

  it('ring scotoma profile produces a mid-peripheral depression', () => {
    const pts = makeStaticThresholdPoints(SCENARIO_PROFILES.ringScotoma)
    const byRing = { central: [] as number[], mid: [] as number[], outer: [] as number[] }
    for (const p of pts) {
      const r = p.eccentricityDeg
      const db = p.thresholdDb ?? 0
      if (r < 6) byRing.central.push(db)
      else if (r < 18) byRing.mid.push(db)
      else byRing.outer.push(db)
    }
    const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)
    // Mid band is a scotoma: lower dB than both central and outer.
    expect(mean(byRing.mid)).toBeLessThan(mean(byRing.central))
    expect(mean(byRing.mid)).toBeLessThan(mean(byRing.outer))
  })
})

describe('ClinicalScenario.staticPoints', () => {
  it('is populated on every scenario with a dense demo grid', () => {
    for (const s of getAllScenarios()) {
      expect(s.staticPoints).toBeDefined()
      // Demo uses a dense 2° grid (larger than the 54-point 24-2).
      expect(s.staticPoints!.length).toBeGreaterThan(54)
      for (const p of s.staticPoints!) {
        expect(p.thresholdDb).toBeDefined()
      }
    }
  })
})
