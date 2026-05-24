import { describe, it, expect } from 'vitest'
import { initStaircase, stepStaircase, DB_MIN_THRESH, DB_MAX_THRESH } from './staircase'

describe('staircase 4-2 dB', () => {
  it('initializes at prior with step 4', () => {
    const s = initStaircase(20)
    expect(s.currentDb).toBe(20)
    expect(s.stepDb).toBe(4)
    expect(s.done).toBe(false)
    expect(s.reversals).toEqual([])
    expect(s.lastResponse).toBe(null)
  })

  it('if seen, steps dimmer (higher dB) by stepDb', () => {
    const s = stepStaircase(initStaircase(20), true)
    expect(s.currentDb).toBe(24)
    expect(s.stepDb).toBe(4)
    expect(s.done).toBe(false)
  })

  it('if not seen, steps brighter (lower dB) by stepDb', () => {
    const s = stepStaircase(initStaircase(20), false)
    expect(s.currentDb).toBe(16)
    expect(s.stepDb).toBe(4)
  })

  it('first reversal drops step to 2 dB and records the reversal', () => {
    let s = initStaircase(20)
    s = stepStaircase(s, true)  // 20 seen → 24
    s = stepStaircase(s, false) // 24 unseen → rev @ 24, step→2, current→22
    expect(s.stepDb).toBe(2)
    expect(s.currentDb).toBe(22)
    expect(s.reversals).toEqual([24])
    expect(s.done).toBe(false)
  })

  it('completes after 2 reversals; threshold = mean of the two reversal dBs', () => {
    // Trace:
    // start 20, step 4
    // seen   → 24 (no rev)
    // seen   → 28 (no rev)
    // unseen → rev1 @ 28, step→2, current→26
    // seen   → rev2 @ 26, done. threshold = (28 + 26) / 2 = 27
    let s = initStaircase(20)
    s = stepStaircase(s, true)
    s = stepStaircase(s, true)
    s = stepStaircase(s, false)
    expect(s.reversals).toEqual([28])
    expect(s.done).toBe(false)
    s = stepStaircase(s, true)
    expect(s.done).toBe(true)
    expect(s.reversals).toEqual([28, 26])
    expect(s.thresholdDb).toBeCloseTo(27, 6)
  })

  it('threshold is mean of distinct reversals (symmetric example)', () => {
    // start 10, step 4
    // seen   → 14 (no rev)
    // unseen → rev1 @ 14, step→2, current→12
    // seen   → rev2 @ 12, done. threshold = (14 + 12) / 2 = 13
    let s = initStaircase(10)
    s = stepStaircase(s, true)
    s = stepStaircase(s, false)
    s = stepStaircase(s, true)
    expect(s.done).toBe(true)
    expect(s.reversals).toEqual([14, 12])
    expect(s.thresholdDb).toBeCloseTo(13, 6)
  })

  it('no-ops once done (idempotent; returns same reference)', () => {
    let s = initStaircase(20)
    s = stepStaircase(s, true)   // →24
    s = stepStaircase(s, false)  // rev1 @ 24
    s = stepStaircase(s, true)   // rev2 @ 22, done
    expect(s.done).toBe(true)
    const before = s
    const after = stepStaircase(s, true)
    expect(after).toBe(before)
  })

  it('runs to 4 reversals when reversalsRequired=4; threshold uses last two', () => {
    // The Normal speed preset uses 4 reversals for a longer, more
    // clinically-precise walk. Threshold still averages the last two
    // reversals — the earlier pair are discarded as prior-biased.
    // start 20, step 4
    // seen   → 24 (no rev)
    // seen   → 28 (no rev)
    // unseen → rev1 @ 28, step→2, current→26
    // seen   → rev2 @ 26, current→28
    // unseen → rev3 @ 28, current→26
    // seen   → rev4 @ 26, done. threshold = (28 + 26) / 2 = 27
    let s = initStaircase(20, 4)
    s = stepStaircase(s, true)
    s = stepStaircase(s, true)
    s = stepStaircase(s, false)
    s = stepStaircase(s, true)
    s = stepStaircase(s, false)
    expect(s.done).toBe(false)
    s = stepStaircase(s, true)
    expect(s.done).toBe(true)
    expect(s.reversals).toEqual([28, 26, 28, 26])
    expect(s.thresholdDb).toBeCloseTo(27, 6)
  })

  it('initStaircase rejects reversalsRequired < 2 or non-integer', () => {
    expect(() => initStaircase(20, 1)).toThrow()
    expect(() => initStaircase(20, 0)).toThrow()
    expect(() => initStaircase(20, 2.5)).toThrow()
    expect(() => initStaircase(20, -3)).toThrow()
  })

  it('terminates at DB_MAX_THRESH if patient keeps seeing (stuck-at-ceiling)', () => {
    // With `seen` every tick there is never a reversal, so currentDb just
    // climbs and eventually pins at DB_MAX_THRESH. Once pinned, two
    // consecutive sees terminate the staircase at the ceiling.
    let s = initStaircase(30)
    for (let i = 0; i < 20; i++) s = stepStaircase(s, true)
    expect(s.currentDb).toBe(DB_MAX_THRESH)
    expect(s.done).toBe(true)
    expect(s.thresholdDb).toBe(DB_MAX_THRESH)
    expect(s.reversals).toEqual([])
  })

  it('terminates at DB_MIN_THRESH if patient keeps not seeing (stuck-at-floor)', () => {
    // Two consecutive unseen at the floor → terminate at 0 dB. Without
    // this, a blind point cycles forever at 0 because clamping doesn't
    // count as a reversal — and the progress bar would stall.
    let s = initStaircase(10)
    for (let i = 0; i < 20; i++) s = stepStaircase(s, false)
    expect(s.currentDb).toBe(DB_MIN_THRESH)
    expect(s.done).toBe(true)
    expect(s.thresholdDb).toBe(DB_MIN_THRESH)
  })

  it('stuck-at-floor needs two consecutive misses at the bound', () => {
    // First miss at the prior is not enough; we need two in a row at the
    // floor so a miss-then-see starting at the prior doesn't false-trigger.
    let s = initStaircase(0)
    s = stepStaircase(s, false) // first tick at floor, lastResponse=null → no termination
    expect(s.done).toBe(false)
    expect(s.currentDb).toBe(0)
    s = stepStaircase(s, false) // second miss at floor → terminate
    expect(s.done).toBe(true)
    expect(s.thresholdDb).toBe(0)
  })

  it('initStaircase clamps a prior outside [0, 35] into range', () => {
    expect(initStaircase(-5).currentDb).toBe(DB_MIN_THRESH)
    expect(initStaircase(100).currentDb).toBe(DB_MAX_THRESH)
  })

  it('constants are the documented [0, 35] dB range', () => {
    expect(DB_MIN_THRESH).toBe(0)
    expect(DB_MAX_THRESH).toBe(35)
  })

  it('reversal is any direction flip (unseen→seen also counts)', () => {
    // start 10 (prior), step 4
    // unseen → 6, no rev (first tick)
    // unseen → 2, no rev (no flip)
    // seen   → rev1 @ 2, step→2, current→4
    // unseen → rev2 @ 4, done. threshold = (2 + 4) / 2 = 3
    let s = initStaircase(10)
    s = stepStaircase(s, false)
    s = stepStaircase(s, false)
    s = stepStaircase(s, true)
    expect(s.reversals).toEqual([2])
    expect(s.stepDb).toBe(2)
    s = stepStaircase(s, false)
    expect(s.done).toBe(true)
    expect(s.reversals).toEqual([2, 4])
    expect(s.thresholdDb).toBeCloseTo(3, 6)
  })
})
