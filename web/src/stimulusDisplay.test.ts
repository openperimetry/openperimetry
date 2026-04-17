import { describe, it, expect } from 'vitest'
import { stimulusDisplayColor } from './stimulusDisplay'
import { STIMULI, ISOPTER_ORDER } from './types'

describe('stimulusDisplayColor', () => {
  it('returns white for every stimulus key', () => {
    for (const key of ISOPTER_ORDER) {
      expect(stimulusDisplayColor(key)).toBe('#ffffff')
    }
  })

  it('does not affect the isopter map color field', () => {
    // Regression: the map color (STIMULI[k].color) must remain distinct per key.
    const colors = new Set(ISOPTER_ORDER.map(k => STIMULI[k].color))
    expect(colors.size).toBe(ISOPTER_ORDER.length)
  })
})
