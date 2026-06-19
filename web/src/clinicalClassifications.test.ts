import { test, expect } from 'vitest'
import { getAllScenarios } from './testFixtures'
import { calcIsopterAreas } from './isopterCalc'
import { NORMAL_ISOPTER_AREA, scoreField, fractionToScore } from './clinicalClassifications'
import { ISOPTER_ORDER } from './types'

test('NORMAL_ISOPTER_AREA stays in sync with the normal fixture', () => {
  const normal = getAllScenarios().find(s => s.id === 'normal')!
  const areas = calcIsopterAreas(normal.points)
  for (const k of ISOPTER_ORDER) {
    expect(Math.round(areas[k]!), k).toBe(NORMAL_ISOPTER_AREA[k])
  }
})

test('stage scenarios self-classify to their own stage', () => {
  const expected: Record<string, string> = {
    'normal': 'normal',
    'early-rp': 'mild',
    'moderate-rp': 'moderate',
    'severe-rp': 'severe',
    'very-severe-rp': 'very-severe',
  }
  for (const s of getAllScenarios()) {
    if (!(s.id in expected)) continue
    const fs = scoreField(calcIsopterAreas(s.points), 999, undefined)!
    expect(fs.band.severity, s.id).toBe(expected[s.id])
  }
})

test('stage scenarios still self-classify under a realistic desktop calibration', () => {
  // Production passes real screen dims, so expectedNormalArea takes the
  // screen-rectangle path and the per-isopter cap binds — verify the bands
  // still hold in that regime (not just the uncapped reference above).
  const desktop = {
    pixelsPerDegree: 18.6, screenWidthPx: 2560, screenHeightPx: 1440,
    maxEccentricityDeg: 96, viewingDistanceCm: 25, brightnessFloor: 0.13, reactionTimeMs: 250,
  } as never
  const expected: Record<string, string> = {
    'normal': 'normal',
    'early-rp': 'mild',
    'moderate-rp': 'moderate',
    'severe-rp': 'severe',
    'very-severe-rp': 'very-severe',
  }
  for (const s of getAllScenarios()) {
    if (!(s.id in expected)) continue
    const fs = scoreField(calcIsopterAreas(s.points), 96, desktop)!
    expect(fs.band.severity, s.id).toBe(expected[s.id])
  }
})

test('fractionToScore is bounded and monotonic', () => {
  expect(fractionToScore(1)).toBe(100)
  expect(fractionToScore(0)).toBe(0)
  expect(fractionToScore(2)).toBe(100) // clamped
  expect(fractionToScore(0.081)).toBeGreaterThan(fractionToScore(0.025))
  expect(fractionToScore(0.30)).toBeGreaterThan(fractionToScore(0.081))
})

test('scoreField is null when no isopter measured, robust to a single low isopter', () => {
  expect(scoreField({}, 60)).toBeNull()
  // A near-normal V4e with a collapsed III4e should not read very-severe —
  // the average of all isopters holds it up (the failure the old grade had).
  const fs = scoreField({ V4e: 3002, III4e: 507, III2e: 133, I4e: 262, I2e: 144 }, 96, {
    pixelsPerDegree: 18.6, screenWidthPx: 2560, screenHeightPx: 1440,
    maxEccentricityDeg: 96, viewingDistanceCm: 25, brightnessFloor: 0.13, reactionTimeMs: 250,
  } as never)!
  expect(fs.band.severity).toBe('moderate')
})
