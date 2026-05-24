import { describe, expect, it } from 'vitest'
import { countCustomGridPoints } from './grids'
import { STANDARD_PROFILES } from './standardProfiles'
import { buildStudyProfileExportDocument, parseStudyProfileFile } from './studyMode'

describe('STANDARD_PROFILES', () => {
  it('has unique ids', () => {
    const ids = STANDARD_PROFILES.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // Round-trip via the same path file-imports use (export → JSON → parse).
  // This is the strongest validation we can run at the unit-test layer:
  // any preset that's missing a required field, has an out-of-range value,
  // or violates the StudyProfile schema would be rejected here.
  for (const profile of STANDARD_PROFILES) {
    it(`${profile.id} round-trips through export/parse`, async () => {
      const doc = buildStudyProfileExportDocument(profile)
      const json = JSON.stringify(doc)
      const fakeFile = new Blob([json], { type: 'application/json' }) as unknown as File
      const reparsed = await parseStudyProfileFile(fakeFile)
      expect(reparsed).toEqual(profile)
    })
  }

  it('pins rapid 48-point profiles to the desktop-derived timing/grid defaults', () => {
    const profiles = STANDARD_PROFILES.filter(p => p.id.startsWith('standard.static-48p'))

    expect(profiles.map(p => p.id)).toEqual([
      'standard.static-48p-fast',
      'standard.static-48p-fixation',
      'standard.static-48p-fixation-alert',
    ])

    for (const profile of profiles) {
      expect(profile.testType).toBe('static')
      expect(profile.speedMode).toBe('normal')
      expect(profile.staticGridPattern).toBe('custom')
      expect(profile.advancedSettings.staticGridPattern).toBe('custom')
      expect(countCustomGridPoints(profile.advancedSettings.customGrid)).toBe(48)
      expect(profile.advancedSettings.customGrid).toEqual({
        spacingXDeg: 7.5,
        spacingYDeg: 6,
        extentXDeg: 22.5,
        extentYDeg: 24,
      })
      expect(profile.advancedSettings.speedPreset).toEqual({
        override: true,
        stimulusMs: 200,
        responseMs: 1000,
        gapMinMs: 700,
        gapMaxMs: 900,
      })
      expect(profile.advancedSettings.backgroundShade).toBe('medium')
    }
  })
})
