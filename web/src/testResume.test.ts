import { describe, it, expect } from 'vitest'
import {
  saveResumeSnapshot,
  loadResumeSnapshot,
  clearResumeSnapshot,
  serializeStaircases,
  deserializeStaircases,
  resumeKey,
  RESUME_MAX_AGE_MS,
} from './testResume'
import { initStaircase, stepStaircase, type StaircaseState } from './staircase'

/** Minimal in-memory Storage stand-in (the node test env has no sessionStorage). */
function fakeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    _map: m,
  }
}

describe('staircase serialization round-trip', () => {
  it('preserves dB, reversals, step and done state through JSON', () => {
    const map = new Map<string, StaircaseState>()
    let a = initStaircase(0, 2)
    a = stepStaircase(a, true)   // walk dimmer
    a = stepStaircase(a, false)  // reversal -> step halves to 2
    map.set('p1', a)
    map.set('p2', initStaircase(0, 4))

    const wire = JSON.parse(JSON.stringify(serializeStaircases(map)))
    const back = deserializeStaircases(wire)

    expect(back.get('p1')).toEqual(map.get('p1'))
    expect(back.get('p2')).toEqual(map.get('p2'))
    expect(back.get('p1')!.stepDb).toBe(2)
  })
})

describe('resume snapshot store', () => {
  it('round-trips a payload through save/load', () => {
    const s = fakeStorage()
    const key = resumeKey('static', 'right')
    const payload = { eye: 'right', trialsDone: 12, results: [{ db: 20 }] }
    saveResumeSnapshot(key, payload, 1000, s)
    expect(loadResumeSnapshot(key, 1000, RESUME_MAX_AGE_MS, s)).toEqual(payload)
  })

  it('returns null and clears a stale snapshot past max age', () => {
    const s = fakeStorage()
    const key = resumeKey('static', 'left')
    saveResumeSnapshot(key, { x: 1 }, 0, s)
    const later = RESUME_MAX_AGE_MS + 1
    expect(loadResumeSnapshot(key, later, RESUME_MAX_AGE_MS, s)).toBeNull()
    // stale entry is purged so it can't resurface
    expect(s.getItem('vfc.resume.static.left')).toBeNull()
  })

  it('ignores snapshots from an incompatible version', () => {
    const s = fakeStorage()
    s.setItem('vfc.resume.static.right', JSON.stringify({ version: 0, savedAt: 1000, payload: { x: 1 } }))
    expect(loadResumeSnapshot('static.right', 1000, RESUME_MAX_AGE_MS, s)).toBeNull()
  })

  it('clear removes the snapshot', () => {
    const s = fakeStorage()
    const key = resumeKey('static', 'right')
    saveResumeSnapshot(key, { x: 1 }, 1000, s)
    clearResumeSnapshot(key, s)
    expect(loadResumeSnapshot(key, 1000, RESUME_MAX_AGE_MS, s)).toBeNull()
  })

  it('no-ops gracefully when storage is unavailable', () => {
    expect(() => saveResumeSnapshot('k', { x: 1 }, 1000, null)).not.toThrow()
    expect(loadResumeSnapshot('k', 1000, RESUME_MAX_AGE_MS, null)).toBeNull()
  })
})
