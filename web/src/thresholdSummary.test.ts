import { describe, it, expect } from 'vitest'
import { summarizeThresholdPoints, thresholdSummaryToMeta } from './thresholdSummary'
import type { TestPoint } from './types'

function pt(thresholdDb: number): TestPoint {
  return {
    meridianDeg: 0,
    eccentricityDeg: 0,
    rawEccentricityDeg: 0,
    detected: true,
    stimulus: 'III4e',
    thresholdDb,
  }
}

describe('summarizeThresholdPoints', () => {
  it('returns zeros on empty input', () => {
    const s = summarizeThresholdPoints([])
    expect(s).toEqual({
      n: 0, scotomaN: 0, ceilingN: 0,
      meanDb: 0, medianDb: 0,
      bin0to10: 0, bin10to20: 0, bin20to30: 0, bin30plus: 0,
    })
  })

  it('ignores points without a thresholdDb', () => {
    const points: TestPoint[] = [
      { ...pt(25) },
      { meridianDeg: 0, eccentricityDeg: 0, rawEccentricityDeg: 0, detected: false, stimulus: 'III4e' },
    ]
    const s = summarizeThresholdPoints(points)
    expect(s.n).toBe(1)
    expect(s.meanDb).toBe(25)
  })

  it('counts scotomas at the floor and ceilings at the ceiling', () => {
    const points = [pt(0), pt(0), pt(34), pt(35), pt(15)]
    const s = summarizeThresholdPoints(points)
    expect(s.scotomaN).toBe(2)   // two points at 0 dB
    expect(s.ceilingN).toBe(2)   // 34 and 35
    expect(s.n).toBe(5)
  })

  it('computes mean and median rounded to 0.1', () => {
    const s = summarizeThresholdPoints([pt(10), pt(20), pt(30)])
    expect(s.meanDb).toBe(20)
    expect(s.medianDb).toBe(20)
  })

  it('median uses midpoint for even-sized samples', () => {
    const s = summarizeThresholdPoints([pt(10), pt(20), pt(30), pt(40)])
    // 40 gets clamped into the 30+ bin in real data; pretending here for median check
    expect(s.medianDb).toBe(25)
  })

  it('bins dBs into [0,10), [10,20), [20,30), [30,35]', () => {
    const s = summarizeThresholdPoints([
      pt(0), pt(5), pt(9.9),
      pt(10), pt(15),
      pt(20), pt(29),
      pt(30), pt(35),
    ])
    expect(s.bin0to10).toBe(3)
    expect(s.bin10to20).toBe(2)
    expect(s.bin20to30).toBe(2)
    expect(s.bin30plus).toBe(2)
  })

  it('thresholdSummaryToMeta stringifies every field', () => {
    const meta = thresholdSummaryToMeta(summarizeThresholdPoints([pt(12), pt(24)]))
    for (const v of Object.values(meta)) expect(typeof v).toBe('string')
    expect(meta.thN).toBe('2')
    expect(meta.thMeanDb).toBe('18')
  })
})
