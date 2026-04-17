/**
 * Advanced test settings — user-tweakable overrides for parameters that
 * otherwise take their defaults from `./testDefaults.ts`.
 *
 * Shape, persistence, and validation live here; the UI to edit them lives
 * in `CalibrationScreen`. Test components read the current settings via
 * the `useAdvancedSettings` hook so one provider at the App root threads
 * overrides through the whole tree.
 *
 * See `docs/superpowers/plans/2026-04-18-advanced-settings.md`.
 */

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import {
  CATCH_TRIAL_EVERY_N,
  FIXATION_LOSS_ALERT_MS,
  FIXATION_LOSS_ALERT_MESSAGE,
  SPEED_PRESETS,
} from './testDefaults'

/** Speed-preset timings + a flag that controls whether the advanced
 *  values replace the per-run speed selector in the static test. The
 *  timing numbers are always populated (matching the built-in "normal"
 *  preset by default) so the exported JSON file shows every knob a
 *  user could tweak — see the `override` field to actually apply them. */
export interface SpeedPresetSettings {
  /** When true, the timings below replace the per-run speed preset
   *  selected inside StaticTest. When false, the static test uses the
   *  built-in SPEED_PRESETS[relaxed|normal|fast] as chosen at runtime. */
  override: boolean
  stimulusMs: number
  responseMs: number
  gapMinMs: number
  gapMaxMs: number
}

export interface AdvancedSettings {
  /** How often a presentation is swapped for a blindspot catch trial. int ≥ 1. */
  catchTrialEveryN: number
  /** Fixation-loss alert duration in ms. 0 disables the overlay. int ≥ 0. */
  fixationAlertMs: number
  /** Text displayed in the fixation-loss alert overlay. ≤ 200 chars. */
  fixationAlertMessage: string
  /** Speed-preset timings; `override` controls whether they apply. */
  speedPreset: SpeedPresetSettings
  /** Pre-calibrated background shade for test screens. */
  backgroundShade: 'dark' | 'medium' | 'light'
}

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = {
  catchTrialEveryN: CATCH_TRIAL_EVERY_N,
  fixationAlertMs: FIXATION_LOSS_ALERT_MS,
  fixationAlertMessage: FIXATION_LOSS_ALERT_MESSAGE,
  speedPreset: { override: false, ...SPEED_PRESETS.normal },
  backgroundShade: 'dark',
}

export function mergeWithDefaults(partial: Partial<AdvancedSettings>): AdvancedSettings {
  return { ...DEFAULT_ADVANCED_SETTINGS, ...partial }
}

/** Validate a raw (unknown-shaped) blob into a Partial<AdvancedSettings>.
 *  Throws on unknown fields, wrong types, or out-of-range values. */
export function validateAdvancedSettings(raw: unknown): Partial<AdvancedSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('settings must be an object')
  }
  const known = new Set(Object.keys(DEFAULT_ADVANCED_SETTINGS))
  const out: Partial<AdvancedSettings> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(k)) throw new Error(`unknown field: ${k}`)
    switch (k) {
      case 'catchTrialEveryN':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
          throw new Error('catchTrialEveryN must be integer ≥ 1')
        }
        out.catchTrialEveryN = v
        break
      case 'fixationAlertMs':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          throw new Error('fixationAlertMs must be integer ≥ 0')
        }
        out.fixationAlertMs = v
        break
      case 'fixationAlertMessage':
        if (typeof v !== 'string' || v.length > 200) {
          throw new Error('fixationAlertMessage must be string ≤ 200 chars')
        }
        out.fixationAlertMessage = v
        break
      case 'speedPreset': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          throw new Error('speedPreset must be an object')
        }
        const o = v as Record<string, unknown>
        if (typeof o.override !== 'boolean') {
          throw new Error('speedPreset.override must be boolean')
        }
        for (const f of ['stimulusMs', 'responseMs', 'gapMinMs', 'gapMaxMs'] as const) {
          const n = o[f]
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
            throw new Error(`speedPreset.${f} must be integer ≥ 0`)
          }
        }
        out.speedPreset = v as AdvancedSettings['speedPreset']
        break
      }
      case 'backgroundShade':
        if (v !== 'dark' && v !== 'medium' && v !== 'light') {
          throw new Error('backgroundShade must be dark|medium|light')
        }
        out.backgroundShade = v
        break
    }
  }
  return out
}

const CTX = createContext<AdvancedSettings>(DEFAULT_ADVANCED_SETTINGS)
export const AdvancedSettingsProvider = CTX.Provider
export const useAdvancedSettings = () => useContext(CTX)

/** Mutator context — separate from the value context so consumers that
 *  only read don't re-render when the setter identity changes. */
const SET_CTX = createContext<(next: AdvancedSettings) => void>(() => {
  throw new Error('useSetAdvancedSettings called outside AdvancedSettingsRoot')
})
export const useSetAdvancedSettings = () => useContext(SET_CTX)

/** Root-level provider: owns the settings state, hydrates from
 *  localStorage, persists on every mutation. Place once near the app
 *  entry point. Any descendant can call `useAdvancedSettings()` to read
 *  and `useSetAdvancedSettings()` to write. */
export function AdvancedSettingsRoot({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AdvancedSettings>(() => loadAdvancedSettings())
  const update = useCallback((next: AdvancedSettings) => {
    setSettings(next)
    saveAdvancedSettings(next)
  }, [])
  return (
    <SET_CTX.Provider value={update}>
      <CTX.Provider value={settings}>{children}</CTX.Provider>
    </SET_CTX.Provider>
  )
}

const STORAGE_KEY = 'vfc-advanced-settings'

/** Read settings from localStorage, merge with defaults. Returns defaults
 *  on any I/O or validation failure (with a console.warn). */
export function loadAdvancedSettings(): AdvancedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_ADVANCED_SETTINGS
    const partial = validateAdvancedSettings(JSON.parse(raw))
    return mergeWithDefaults(partial)
  } catch (e) {
    console.warn('Discarding invalid advancedSettings in localStorage:', e)
    return DEFAULT_ADVANCED_SETTINGS
  }
}

/** Persist settings to localStorage. Only fields that differ from
 *  defaults are written, keeping the stored JSON compact and making
 *  `defaults → save → load` an identity on DEFAULT_ADVANCED_SETTINGS. */
export function saveAdvancedSettings(s: AdvancedSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(compactSettings(s)))
}

/** Return a Partial containing only the fields that differ from defaults.
 *  Shared by `saveAdvancedSettings` and the export-file helpers so the
 *  stored JSON and the shareable file stay consistently compact. */
export function compactSettings(s: AdvancedSettings): Partial<AdvancedSettings> {
  const out: Partial<AdvancedSettings> = {}
  for (const [k, v] of Object.entries(s) as [keyof AdvancedSettings, unknown][]) {
    if (JSON.stringify(v) !== JSON.stringify(DEFAULT_ADVANCED_SETTINGS[k])) {
      ;(out as Record<string, unknown>)[k] = v
    }
  }
  return out
}

/** Shape of an exported settings document. The `vfcSettingsVersion`
 *  string is a semver-like token; the import path only requires the
 *  leading "1." for forward compatibility with minor additions.
 *
 *  `settings` carries every field — not just the ones that differ from
 *  defaults — so the exported file doubles as a discoverable schema: a
 *  recipient can open it and immediately see every knob they could
 *  tweak. The import path still accepts partial settings (old exports
 *  and hand-written files continue to work), so this only affects the
 *  output shape. */
export interface ExportedSettingsDocument {
  vfcSettingsVersion: string
  generatedAt: string
  settings: AdvancedSettings
}

export const EXPORT_VERSION = '1.0.0'

/** Build an exportable document from the current settings. Emits the
 *  full {@link AdvancedSettings} object (not the compact diff against
 *  defaults) so the file is self-describing. */
export function buildExportDocument(
  s: AdvancedSettings,
  now: Date = new Date(),
): ExportedSettingsDocument {
  return {
    vfcSettingsVersion: EXPORT_VERSION,
    generatedAt: now.toISOString(),
    settings: { ...s },
  }
}

/** Error thrown by {@link parseSettingsFile} when the uploaded file cannot
 *  be turned into valid settings. The message is safe to show to users. */
export class SettingsImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsImportError'
  }
}

/** Read and validate a user-uploaded settings file. Returns a fully
 *  merged {@link AdvancedSettings} suitable to hand straight to
 *  `useSetAdvancedSettings()`. Any parse or validation failure is
 *  wrapped in {@link SettingsImportError} so callers can render one
 *  clean error message. */
export async function parseSettingsFile(file: File): Promise<AdvancedSettings> {
  let text: string
  try {
    text = await file.text()
  } catch (e) {
    throw new SettingsImportError(`could not read file: ${(e as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new SettingsImportError(`file is not valid JSON: ${(e as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SettingsImportError('file must contain a JSON object')
  }
  const obj = raw as Record<string, unknown>
  const version = obj.vfcSettingsVersion
  if (typeof version !== 'string' || !version.startsWith('1.')) {
    throw new SettingsImportError(
      `unsupported vfcSettingsVersion: ${String(version)} (expected 1.x)`,
    )
  }
  if (obj.settings === undefined) {
    throw new SettingsImportError('file is missing a "settings" field')
  }
  let partial: Partial<AdvancedSettings>
  try {
    partial = validateAdvancedSettings(obj.settings)
  } catch (e) {
    throw new SettingsImportError(`invalid settings: ${(e as Error).message}`)
  }
  return mergeWithDefaults(partial)
}

/** Trigger a browser download containing the current settings as JSON.
 *  Pattern mirrors `downloadOvfx` in `./ovfx.ts`. */
export function exportSettingsAsFile(s: AdvancedSettings): void {
  const doc = buildExportDocument(s)
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `vfc-settings_${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
