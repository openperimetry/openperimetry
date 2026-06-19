import { describe, it, expect } from 'vitest'
import { detectAnomalies, detectRPFindings } from './fieldAnalysis'
import { scoreField } from './clinicalClassifications'
import type { StimulusKey, TestPoint, CalibrationData } from './types'

const DESKTOP_CAL = {
  pixelsPerDegree: 18.6,
  screenWidthPx: 2560,
  screenHeightPx: 1440,
  maxEccentricityDeg: 96,
  viewingDistanceCm: 25,
  brightnessFloor: 0.13,
  reactionTimeMs: 250,
} as unknown as CalibrationData

describe('detectRPFindings concentric card stays consistent with the field score', () => {
  it('cannot say "constricted" when scoreField classifies the field as normal', () => {
    // The historical bug: the card used a single-isopter (<65% of III4e) test
    // while the headline used the multi-isopter score, so a normal field could
    // still be flagged "tunnel vision". Same areas + calibration must agree.
    const areas = { V4e: 8369, III4e: 5000, III2e: 5000, I4e: 3000, I2e: 1400 }
    const fs = scoreField(areas, 96, DESKTOP_CAL)!
    expect(fs.band.severity).toBe('normal')
    const card = detectRPFindings([], areas, 96, DESKTOP_CAL, fs)
      .find(f => f.label === 'Concentric field constriction')!
    expect(card.present).toBe(false)
    expect(card.tone).toBe('ok')
  })

  it('does flag "constricted" when scoreField is a loss stage', () => {
    const tunnel = { V4e: 600, III4e: 310, III2e: 80, I4e: 52, I2e: 20 }
    const fs = scoreField(tunnel, 96, DESKTOP_CAL)!
    expect(['mild', 'moderate', 'severe', 'very-severe']).toContain(fs.band.severity)
    const card = detectRPFindings([], tunnel, 96, DESKTOP_CAL, fs)
      .find(f => f.label === 'Concentric field constriction')!
    expect(card.present).toBe(true)
  })

  it('computes the score itself when none is passed (same verdict)', () => {
    const areas = { V4e: 8369, III4e: 5000, III2e: 5000, I4e: 3000, I2e: 1400 }
    const card = detectRPFindings([], areas, 96, DESKTOP_CAL)
      .find(f => f.label === 'Concentric field constriction')!
    expect(card.present).toBe(false)
  })
})

// Build N detected probe points for one isopter. Identical eccentricity keeps
// the shape-irregularity check quiet so these tests isolate the ordering flag.
function pts(stimulus: StimulusKey, n: number): TestPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    meridianDeg: i * 30,
    eccentricityDeg: 10,
    rawEccentricityDeg: 10,
    detected: true,
    stimulus,
  }))
}

describe('detectAnomalies — sparse isopter ordering', () => {
  // I4e mapped 10× larger than III2e — an ordering reversal by area alone.
  const areas: Partial<Record<StimulusKey, number>> = { III2e: 10, I4e: 100 }

  it('suppresses the reversal flag when an isopter is too sparse to trust', () => {
    // III2e barely seen (2 points) — common for a dim stimulus in a headset.
    const points = [...pts('III2e', 2), ...pts('I4e', 8)]
    const anomalies = detectAnomalies(points, areas)
    expect(anomalies.some(a => a.label.includes('larger than'))).toBe(false)
  })

  it('still flags the reversal when both isopters are well mapped', () => {
    const points = [...pts('III2e', 8), ...pts('I4e', 8)]
    const anomalies = detectAnomalies(points, areas)
    expect(
      anomalies.some(a => a.label.includes('I4e') && a.label.includes('III2e')),
    ).toBe(true)
  })
})
