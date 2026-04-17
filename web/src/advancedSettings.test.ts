import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DEFAULT_ADVANCED_SETTINGS,
  EXPORT_VERSION,
  SettingsImportError,
  buildExportDocument,
  compactSettings,
  mergeWithDefaults,
  parseSettingsFile,
  validateAdvancedSettings,
  loadAdvancedSettings,
  saveAdvancedSettings,
  type AdvancedSettings,
} from './advancedSettings'

/** Build a File-shaped object with a `.text()` method. Keeps the tests
 *  runnable under jsdom without pulling in the full DOM File class. */
function makeFile(body: string): File {
  return { text: async () => body } as unknown as File
}

describe('mergeWithDefaults', () => {
  it('returns defaults when given {}', () => {
    expect(mergeWithDefaults({})).toEqual(DEFAULT_ADVANCED_SETTINGS)
  })

  it('overrides only specified fields', () => {
    const partial = { catchTrialEveryN: 5 } as Partial<AdvancedSettings>
    const merged = mergeWithDefaults(partial)
    expect(merged.catchTrialEveryN).toBe(5)
    expect(merged.fixationAlertMs).toBe(DEFAULT_ADVANCED_SETTINGS.fixationAlertMs)
    expect(merged.fixationAlertMessage).toBe(DEFAULT_ADVANCED_SETTINGS.fixationAlertMessage)
    expect(merged.backgroundShade).toBe(DEFAULT_ADVANCED_SETTINGS.backgroundShade)
  })

  it('merges nested speedPreset as-is (not field-by-field)', () => {
    const sp = { override: true, stimulusMs: 700, responseMs: 2000, gapMinMs: 400, gapMaxMs: 800 }
    const merged = mergeWithDefaults({ speedPreset: sp })
    expect(merged.speedPreset).toEqual(sp)
  })
})

describe('validateAdvancedSettings', () => {
  it('rejects non-object input', () => {
    expect(() => validateAdvancedSettings(null)).toThrow()
    expect(() => validateAdvancedSettings('x' as unknown)).toThrow()
    expect(() => validateAdvancedSettings(42 as unknown)).toThrow()
  })

  it('rejects unknown fields', () => {
    const bad = { ...DEFAULT_ADVANCED_SETTINGS, malicious: 1 } as unknown
    expect(() => validateAdvancedSettings(bad)).toThrow(/unknown field/i)
  })

  it('rejects negative cadence', () => {
    expect(() => validateAdvancedSettings({ catchTrialEveryN: -1 })).toThrow()
  })

  it('rejects zero cadence (must be ≥ 1)', () => {
    expect(() => validateAdvancedSettings({ catchTrialEveryN: 0 })).toThrow()
  })

  it('rejects non-integer cadence', () => {
    expect(() => validateAdvancedSettings({ catchTrialEveryN: 1.5 })).toThrow()
  })

  it('accepts zero fixationAlertMs (disabled)', () => {
    expect(validateAdvancedSettings({ fixationAlertMs: 0 })).toEqual({ fixationAlertMs: 0 })
  })

  it('rejects negative fixationAlertMs', () => {
    expect(() => validateAdvancedSettings({ fixationAlertMs: -1 })).toThrow()
  })

  it('rejects oversized fixationAlertMessage', () => {
    expect(() => validateAdvancedSettings({ fixationAlertMessage: 'x'.repeat(201) })).toThrow()
  })

  it('rejects non-string fixationAlertMessage', () => {
    expect(() => validateAdvancedSettings({ fixationAlertMessage: 123 as unknown as string })).toThrow()
  })

  it('accepts a disabled speedPreset', () => {
    const sp = { override: false, stimulusMs: 500, responseMs: 1400, gapMinMs: 350, gapMaxMs: 650 }
    expect(validateAdvancedSettings({ speedPreset: sp })).toEqual({ speedPreset: sp })
  })

  it('rejects speedPreset without an override flag', () => {
    expect(() =>
      validateAdvancedSettings({
        speedPreset: { stimulusMs: 500, responseMs: 1400, gapMinMs: 300, gapMaxMs: 600 } as unknown as AdvancedSettings['speedPreset'],
      }),
    ).toThrow(/override.*boolean/)
  })

  it('rejects speedPreset missing a timing field', () => {
    expect(() =>
      validateAdvancedSettings({
        speedPreset: { override: true, stimulusMs: 500, responseMs: 1400, gapMinMs: 300 } as unknown as AdvancedSettings['speedPreset'],
      }),
    ).toThrow()
  })

  it('rejects speedPreset with a negative field', () => {
    expect(() =>
      validateAdvancedSettings({
        speedPreset: { override: true, stimulusMs: -1, responseMs: 1400, gapMinMs: 300, gapMaxMs: 600 },
      }),
    ).toThrow()
  })

  it('rejects unknown backgroundShade', () => {
    expect(() => validateAdvancedSettings({ backgroundShade: 'purple' as unknown as 'dark' })).toThrow()
  })

  it('accepts a minimal valid override', () => {
    expect(validateAdvancedSettings({ catchTrialEveryN: 7 })).toEqual({ catchTrialEveryN: 7 })
  })

  it('accepts a full valid override', () => {
    const full: AdvancedSettings = {
      catchTrialEveryN: 5,
      fixationAlertMs: 2000,
      fixationAlertMessage: 'stay focused',
      speedPreset: { override: true, stimulusMs: 500, responseMs: 1400, gapMinMs: 300, gapMaxMs: 600 },
      backgroundShade: 'medium',
    }
    expect(validateAdvancedSettings(full)).toEqual(full)
  })
})

describe('loadAdvancedSettings / saveAdvancedSettings', () => {
  let store: Record<string, string> = {}

  beforeEach(() => {
    store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
      clear: () => {
        store = {}
      },
      key: () => null,
      length: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns defaults when storage is empty', () => {
    expect(loadAdvancedSettings()).toEqual(DEFAULT_ADVANCED_SETTINGS)
  })

  it('round-trips an override', () => {
    const s: AdvancedSettings = { ...DEFAULT_ADVANCED_SETTINGS, catchTrialEveryN: 13 }
    saveAdvancedSettings(s)
    expect(loadAdvancedSettings().catchTrialEveryN).toBe(13)
  })

  it('save omits default-valued fields (compact JSON)', () => {
    saveAdvancedSettings({ ...DEFAULT_ADVANCED_SETTINGS, catchTrialEveryN: 13 })
    const stored = JSON.parse(store['vfc-advanced-settings'])
    expect(stored).toEqual({ catchTrialEveryN: 13 })
  })

  it('save of all-defaults produces {}', () => {
    saveAdvancedSettings(DEFAULT_ADVANCED_SETTINGS)
    expect(JSON.parse(store['vfc-advanced-settings'])).toEqual({})
  })

  it('load discards malformed JSON and returns defaults', () => {
    store['vfc-advanced-settings'] = '{not json'
    expect(loadAdvancedSettings()).toEqual(DEFAULT_ADVANCED_SETTINGS)
  })

  it('load discards invalid-but-parseable settings and returns defaults', () => {
    store['vfc-advanced-settings'] = JSON.stringify({ catchTrialEveryN: -5 })
    expect(loadAdvancedSettings()).toEqual(DEFAULT_ADVANCED_SETTINGS)
  })
})

describe('compactSettings', () => {
  it('returns {} for all-defaults', () => {
    expect(compactSettings(DEFAULT_ADVANCED_SETTINGS)).toEqual({})
  })

  it('includes only fields that differ from defaults', () => {
    const s: AdvancedSettings = { ...DEFAULT_ADVANCED_SETTINGS, catchTrialEveryN: 7, backgroundShade: 'light' }
    expect(compactSettings(s)).toEqual({ catchTrialEveryN: 7, backgroundShade: 'light' })
  })

  it('treats nested speedPreset by deep-equality', () => {
    const sp = { override: true, stimulusMs: 500, responseMs: 1400, gapMinMs: 350, gapMaxMs: 650 }
    const s: AdvancedSettings = { ...DEFAULT_ADVANCED_SETTINGS, speedPreset: sp }
    expect(compactSettings(s)).toEqual({ speedPreset: sp })
  })

  it('omits speedPreset when it matches the default (override=false, normal timings)', () => {
    expect(compactSettings(DEFAULT_ADVANCED_SETTINGS)).toEqual({})
  })
})

describe('buildExportDocument', () => {
  it('wraps every setting with version and timestamp', () => {
    const now = new Date('2026-01-15T12:00:00.000Z')
    const s: AdvancedSettings = { ...DEFAULT_ADVANCED_SETTINGS, catchTrialEveryN: 9 }
    const doc = buildExportDocument(s, now)
    expect(doc.vfcSettingsVersion).toBe(EXPORT_VERSION)
    expect(doc.generatedAt).toBe('2026-01-15T12:00:00.000Z')
    expect(doc.settings).toEqual(s)
  })

  it('emits every field so the file is self-describing', () => {
    const doc = buildExportDocument(DEFAULT_ADVANCED_SETTINGS)
    expect(Object.keys(doc.settings).sort()).toEqual(
      Object.keys(DEFAULT_ADVANCED_SETTINGS).sort(),
    )
    expect(doc.settings).toEqual(DEFAULT_ADVANCED_SETTINGS)
  })

  it('round-trips through validate + merge back to the original', () => {
    const s: AdvancedSettings = {
      catchTrialEveryN: 12,
      fixationAlertMs: 800,
      fixationAlertMessage: 'Keep looking',
      speedPreset: { override: true, stimulusMs: 450, responseMs: 1200, gapMinMs: 300, gapMaxMs: 600 },
      backgroundShade: 'medium',
    }
    const doc = buildExportDocument(s)
    const reparsed = mergeWithDefaults(validateAdvancedSettings(doc.settings))
    expect(reparsed).toEqual(s)
  })
})

describe('parseSettingsFile', () => {
  it('accepts a valid export and returns merged settings', async () => {
    const doc = buildExportDocument({
      ...DEFAULT_ADVANCED_SETTINGS,
      catchTrialEveryN: 11,
      backgroundShade: 'light',
    })
    const parsed = await parseSettingsFile(makeFile(JSON.stringify(doc)))
    expect(parsed.catchTrialEveryN).toBe(11)
    expect(parsed.backgroundShade).toBe('light')
    // Unspecified fields fall back to defaults.
    expect(parsed.fixationAlertMs).toBe(DEFAULT_ADVANCED_SETTINGS.fixationAlertMs)
  })

  it('raises SettingsImportError on invalid JSON', async () => {
    await expect(parseSettingsFile(makeFile('{not json'))).rejects.toBeInstanceOf(SettingsImportError)
  })

  it('raises SettingsImportError when the top-level is not an object', async () => {
    await expect(parseSettingsFile(makeFile('[]'))).rejects.toThrow(SettingsImportError)
    await expect(parseSettingsFile(makeFile('42'))).rejects.toThrow(SettingsImportError)
  })

  it('raises SettingsImportError on unsupported version', async () => {
    const doc = { vfcSettingsVersion: '2.0.0', generatedAt: '2026-01-01', settings: {} }
    await expect(parseSettingsFile(makeFile(JSON.stringify(doc)))).rejects.toThrow(/unsupported.*2\.0\.0/)
  })

  it('raises SettingsImportError on missing settings key', async () => {
    const doc = { vfcSettingsVersion: EXPORT_VERSION, generatedAt: '2026-01-01' }
    await expect(parseSettingsFile(makeFile(JSON.stringify(doc)))).rejects.toThrow(/missing.*settings/)
  })

  it('raises SettingsImportError on unknown fields inside settings', async () => {
    const doc = {
      vfcSettingsVersion: EXPORT_VERSION,
      generatedAt: '2026-01-01',
      settings: { catchTrialEveryN: 5, sneakyField: 1 },
    }
    await expect(parseSettingsFile(makeFile(JSON.stringify(doc)))).rejects.toThrow(/unknown field/)
  })

  it('accepts forward-compatible 1.x versions', async () => {
    const doc = {
      vfcSettingsVersion: '1.99.0',
      generatedAt: '2026-01-01',
      settings: { catchTrialEveryN: 3 },
    }
    const parsed = await parseSettingsFile(makeFile(JSON.stringify(doc)))
    expect(parsed.catchTrialEveryN).toBe(3)
  })
})
