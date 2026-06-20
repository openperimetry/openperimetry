import { describe, it, expect } from 'vitest'
import { splitHash, demoScenarioFromHash, demoHash, adjacentScenarioId, DEMO_HASH, demoTargetFromHash } from './demoRoute'

describe('splitHash', () => {
  it('splits head and rest', () => {
    expect(splitHash('#demos/early-rp')).toEqual({ head: 'demos', rest: 'early-rp' })
  })
  it('handles a bare route', () => {
    expect(splitHash('#references')).toEqual({ head: 'references', rest: '' })
  })
  it('handles the demo picker hash', () => {
    expect(splitHash('#demos')).toEqual({ head: 'demos', rest: '' })
  })
  it('handles an empty hash', () => {
    expect(splitHash('')).toEqual({ head: '', rest: '' })
  })
  it('strips a leading #/ and lowercases', () => {
    expect(splitHash('#/Demos/Early-RP')).toEqual({ head: 'demos', rest: 'early-rp' })
  })
})

describe('demoScenarioFromHash', () => {
  it('returns the scenario id for a demo hash', () => {
    expect(demoScenarioFromHash('#demos/moderate-rp')).toBe('moderate-rp')
  })
  it('returns null for the picker hash', () => {
    expect(demoScenarioFromHash('#demos')).toBeNull()
  })
  it('returns null for a non-demo hash', () => {
    expect(demoScenarioFromHash('#references')).toBeNull()
  })
})

describe('demoHash', () => {
  it('builds the picker hash for null', () => {
    expect(demoHash(null)).toBe(DEMO_HASH)
  })
  it('builds a scenario hash', () => {
    expect(demoHash('severe-rp')).toBe('demos/severe-rp')
  })
})

describe('adjacentScenarioId', () => {
  const ids = ['a', 'b', 'c']
  it('returns the next id', () => {
    expect(adjacentScenarioId(ids, 'a', 1)).toBe('b')
  })
  it('returns the previous id', () => {
    expect(adjacentScenarioId(ids, 'b', -1)).toBe('a')
  })
  it('wraps forward past the end', () => {
    expect(adjacentScenarioId(ids, 'c', 1)).toBe('a')
  })
  it('wraps backward past the start', () => {
    expect(adjacentScenarioId(ids, 'a', -1)).toBe('c')
  })
  it('returns null when the current id is unknown', () => {
    expect(adjacentScenarioId(ids, 'z', 1)).toBeNull()
  })
})

describe('demoTargetFromHash', () => {
  it('parses a bare scenario as goldmann', () => {
    expect(demoTargetFromHash('#demos/early-rp')).toEqual({ id: 'early-rp', mode: 'goldmann' })
  })
  it('parses a /static suffix as static', () => {
    expect(demoTargetFromHash('#demos/early-rp/static')).toEqual({ id: 'early-rp', mode: 'static' })
  })
  it('returns no id for the picker hash', () => {
    expect(demoTargetFromHash('#demos')).toEqual({ id: null, mode: 'goldmann' })
  })
  it('returns no id for a non-demo hash', () => {
    expect(demoTargetFromHash('#references')).toEqual({ id: null, mode: 'goldmann' })
  })
})

describe('demoHash with mode', () => {
  it('builds a goldmann hash by default', () => {
    expect(demoHash('early-rp')).toBe('demos/early-rp')
    expect(demoHash('early-rp', 'goldmann')).toBe('demos/early-rp')
  })
  it('builds a static hash', () => {
    expect(demoHash('early-rp', 'static')).toBe('demos/early-rp/static')
  })
  it('ignores mode for the picker hash', () => {
    expect(demoHash(null, 'static')).toBe('demos')
  })
})
