/**
 * Collapsible "Advanced test settings" panel, rendered inside the
 * CalibrationScreen's final "Ready to test" step. Closed by default so
 * casual users don't see it; reads and writes through the global
 * AdvancedSettings context so changes persist across reloads.
 *
 * See `docs/superpowers/plans/2026-04-18-advanced-settings.md` (Task B.1).
 */

import { useMemo, useRef, useState } from 'react'
import {
  DEFAULT_ADVANCED_SETTINGS,
  SettingsImportError,
  exportSettingsAsFile,
  parseSettingsFile,
  useAdvancedSettings,
  useSetAdvancedSettings,
  type AdvancedSettings,
} from '../advancedSettings'
import { SPEED_PRESETS, type SpeedPresetName } from '../testDefaults'
import {
  CUSTOM_GRID_PRESETS,
  countCustomGridPoints,
  generateCustomGrid,
  type CustomGridParams,
  type CustomGridPresetName,
  type StaticGridPattern,
} from '../grids'
import { SensitivityFieldPreview } from './SensitivityFieldPreview'

interface Props {
  /** The user's currently-selected speed preset. Used to auto-fill
   *  the speed-override fields when the user first enables the toggle. */
  speedPreset?: SpeedPresetName
  /** Which test the panel is being shown for. The speed-preset override
   *  and the static grid pattern selector are only consumed by the
   *  Static test, so we hide them for Goldmann to avoid presenting
   *  settings that have no effect on the run the user is about to
   *  start. Defaults to `'static'` to preserve the existing behaviour
   *  for callers that don't pass a mode. */
  testMode?: 'goldmann' | 'static'
}

export function AdvancedSettingsPanel({ speedPreset = 'normal', testMode = 'static' }: Props) {
  const showStaticOnly = testMode === 'static'
  const settings = useAdvancedSettings()
  const setSettings = useSetAdvancedSettings()
  const [open, setOpen] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = '' // allow re-picking the same file after an error
    if (!file) return
    setImportError(null)
    setImportSuccess(false)
    try {
      const imported = await parseSettingsFile(file)
      setSettings(imported)
      setImportSuccess(true)
    } catch (e) {
      setImportError(
        e instanceof SettingsImportError ? e.message : `unexpected error: ${(e as Error).message}`,
      )
    }
  }

  const update = <K extends keyof AdvancedSettings>(key: K, value: AdvancedSettings[K]) => {
    setSettings({ ...settings, [key]: value })
  }

  /** When the user first enables the override, seed the four timing
   *  fields from the currently-selected built-in preset so they don't
   *  start with whatever stale values were last entered. */
  const toggleSpeedOverride = (enabled: boolean) => {
    update('speedPreset', enabled
      ? { override: true, ...SPEED_PRESETS[speedPreset] }
      : { ...settings.speedPreset, override: false })
  }

  const updateSpeedField = (
    field: 'stimulusMs' | 'responseMs' | 'gapMinMs' | 'gapMaxMs',
    value: number,
  ) => {
    update('speedPreset', { ...settings.speedPreset, [field]: value })
  }

  const reset = () => setSettings(DEFAULT_ADVANCED_SETTINGS)

  // ---------- Custom sensitivity-field generator helpers ----------
  /** Detect which built-in preset (if any) the current custom-grid
   *  params match. When nothing matches, the selector shows "Manual"
   *  and the numeric fields become editable. `'manual'` is a local
   *  sentinel separate from the `'custom'` staticGridPattern value. */
  const currentCustomPreset: CustomGridPresetName | 'manual' = useMemo(() => {
    const g = settings.customGrid
    for (const name of ['screening', 'fast', 'normal'] as const) {
      const p = CUSTOM_GRID_PRESETS[name]
      if (
        p.spacingXDeg === g.spacingXDeg &&
        p.spacingYDeg === g.spacingYDeg &&
        p.extentXDeg === g.extentXDeg &&
        p.extentYDeg === g.extentYDeg
      ) {
        return name
      }
    }
    return 'manual'
  }, [settings.customGrid])

  const setStaticGridPattern = (pattern: StaticGridPattern) =>
    update('staticGridPattern', pattern)

  const setCustomGrid = (grid: CustomGridParams) => update('customGrid', grid)

  /** Apply a named preset to the custom-grid params. */
  const pickCustomPreset = (name: CustomGridPresetName | 'manual') => {
    if (name === 'manual') return // no-op; user edits fields directly
    setCustomGrid({ ...CUSTOM_GRID_PRESETS[name] })
  }

  /** Numeric-field edit helper with inline clamping so a user can't
   *  type an extent below the half-spacing (which would generate zero
   *  points) or above the rendered preview's max eccentricity. */
  const updateCustomField = (field: keyof CustomGridParams, value: number) => {
    if (!Number.isFinite(value) || value <= 0 || value > 90) return
    setCustomGrid({ ...settings.customGrid, [field]: value })
  }

  const customPreviewPoints = useMemo(
    () => generateCustomGrid(settings.customGrid, 'right'),
    [settings.customGrid],
  )

  return (
    <div className="bg-surface border border-line rounded-2xl">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="advanced-settings-body"
        className="w-full flex items-center justify-between px-4 py-3 text-left text-xs text-muted hover:text-body"
      >
        <span>Advanced test settings (optional)</span>
        <span aria-hidden className="font-mono text-muted">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div
          id="advanced-settings-body"
          className="px-4 pb-4 pt-1 space-y-4 text-xs text-muted border-t border-line"
        >
          {/* Pre-test position screen — shows the HeadGuide profile and
              the "sit X cm from the screen, cover Y eye" prompt. On by
              default because the visual is the clearest way to convey
              the intended posture. */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.showPositionGuide}
                onChange={e => update('showPositionGuide', e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-indigo-400"
              />
              <span className="text-body">Show position guide before test</span>
            </label>
          </div>

          {/* Initial blindspot position check — separate from the guide
              above. Off by default because the dot-check adds a second
              screen and is most useful for clinic / study workflows. */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.initialBlindspotCheck}
                onChange={e => update('initialBlindspotCheck', e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-indigo-400"
              />
              <span className="text-body">Blindspot check before test</span>
            </label>
          </div>

          {/* Reaction-time calibration — off by default. The Goldmann
              test reaction-corrects stimulus positions using the median
              of a 5-trial RT measurement, but for most users the
              fallback default (CALIBRATION.DEFAULT_REACTION_TIME_MS) is
              close enough that the extra calibration step felt like
              friction without a meaningful accuracy gain. Opt in here
              for users who want the personalised compensation. Has no
              effect on the static test (which doesn't reaction-correct
              positions and always skips this step). */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.measureReactionTime}
                onChange={e => update('measureReactionTime', e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-indigo-400"
              />
              <span className="text-body">Measure my reaction time (Goldmann only)</span>
            </label>
            <p className="mt-1 pl-5 text-[11px] leading-relaxed text-muted">
              Adds a 5-trial reaction-time test to the calibration. When off, a default reaction time is used.
            </p>
          </div>

          {/* Blindspot catch trials */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.catchTrialsEnabled}
                onChange={e => update('catchTrialsEnabled', e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-indigo-400"
              />
              <span className="text-body">Blindspot catch trials</span>
            </label>
            {settings.catchTrialsEnabled && (
              <div className="space-y-1 pl-5">
                <label htmlFor="adv-catch" className="block text-muted">
                  Cadence
                  <span className="ml-1 text-muted font-normal">
                    (1 blindspot trial every N presentations)
                  </span>
                </label>
                <input
                  id="adv-catch"
                  type="number"
                  min={1}
                  max={50}
                  value={settings.catchTrialEveryN}
                  onChange={e => {
                    const n = Number(e.target.value)
                    if (Number.isInteger(n) && n >= 1 && n <= 50) update('catchTrialEveryN', n)
                  }}
                  className="w-24 px-2 py-1 rounded bg-surface border border-line font-mono text-ink"
                />
              </div>
            )}
          </div>

          {/* Fixation-alert duration */}
          <div className="space-y-1">
            <label htmlFor="adv-alert-ms" className="block text-body">
              Fixation-alert duration
              <span className="ml-1 text-muted font-normal">(ms; 0 = disabled)</span>
            </label>
            <input
              id="adv-alert-ms"
              type="number"
              min={0}
              max={5000}
              step={100}
              value={settings.fixationAlertMs}
              onChange={e => {
                const n = Number(e.target.value)
                if (Number.isInteger(n) && n >= 0 && n <= 5000) update('fixationAlertMs', n)
              }}
              className="w-24 px-2 py-1 rounded bg-surface border border-line font-mono text-ink"
            />
          </div>

          {/* Fixation-alert message */}
          <div className="space-y-1">
            <label htmlFor="adv-alert-msg" className="block text-body">
              Fixation-alert message
            </label>
            <input
              id="adv-alert-msg"
              type="text"
              maxLength={200}
              value={settings.fixationAlertMessage}
              onChange={e => update('fixationAlertMessage', e.target.value)}
              className="w-full px-2 py-1 rounded bg-surface border border-line text-ink"
            />
          </div>

          {/* Speed preset — static test only. Goldmann uses a different
              pacing model (block-sequence shortening) that doesn't read
              these stimulus/response/gap fields, so hiding them prevents
              the setting from looking live when it has no effect. */}
          {showStaticOnly && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={settings.speedPreset.override}
                  onChange={e => toggleSpeedOverride(e.target.checked)}
                  className="accent-amber-500"
                />
                Override speed-preset timings
              </label>

              <div className="grid grid-cols-2 gap-2 pl-6">
                {(['stimulusMs', 'responseMs', 'gapMinMs', 'gapMaxMs'] as const).map(f => (
                  <label key={f} className="space-y-1">
                    <span className="block text-muted text-[11px]">{f}</span>
                    <input
                      type="number"
                      min={0}
                      max={5000}
                      step={10}
                      value={settings.speedPreset[f]}
                      disabled={!settings.speedPreset.override}
                      onChange={e => {
                        const n = Number(e.target.value)
                        if (Number.isInteger(n) && n >= 0 && n <= 5000) updateSpeedField(f, n)
                      }}
                      className="w-full px-2 py-1 rounded bg-surface border border-line font-mono text-ink disabled:opacity-50"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Static grid pattern + parameter-driven custom generator —
              static test only. The Goldmann kinetic test doesn't use a
              discrete grid, so this section would be meaningless for it. */}
          {showStaticOnly && (
          <fieldset className="space-y-2 pt-2 border-t border-line">
            <legend className="text-body">Static grid pattern</legend>
            <div className="flex gap-3 pt-1 flex-wrap">
              {(['24-2', '30-2', '10-2', 'custom'] as const).map(p => (
                <label key={p} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="adv-grid-pattern"
                    value={p}
                    checked={settings.staticGridPattern === p}
                    onChange={() => setStaticGridPattern(p)}
                    className="accent-amber-500"
                  />
                  {p === 'custom' ? 'Custom' : p}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-muted pl-0">
              24-2 / 30-2 / 10-2 are the standard clinical grids. Custom uses a
              parameter-driven generator with configurable spacing and extent.
            </p>

            {settings.staticGridPattern === 'custom' && (
              <div className="space-y-3 pt-2 border-t border-line">
                <div className="flex items-center gap-2">
                  <label htmlFor="adv-custom-preset" className="text-body">
                    Grid preset
                  </label>
                  <select
                    id="adv-custom-preset"
                    value={currentCustomPreset}
                    onChange={e => pickCustomPreset(e.target.value as CustomGridPresetName | 'manual')}
                    className="bg-surface border border-line rounded px-2 py-1 text-ink"
                  >
                    <option value="screening">Screening (48 pts · 7.5° × 6° · ±22.5° × ±24°)</option>
                    <option value="fast">Fast (6° spacing, ±24°)</option>
                    <option value="normal">Normal (4° spacing, ±20°)</option>
                    <option value="manual">Manual</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2 pl-0">
                  {(['spacingXDeg', 'spacingYDeg', 'extentXDeg', 'extentYDeg'] as const).map(f => (
                    <label key={f} className="space-y-1">
                      <span className="block text-muted text-[11px]">
                        {f.replace('Deg', '')} (°)
                      </span>
                      <input
                        type="number"
                        min={0.5}
                        max={90}
                        step={0.5}
                        value={settings.customGrid[f]}
                        disabled={currentCustomPreset !== 'manual'}
                        onChange={e => updateCustomField(f, Number(e.target.value))}
                        className="w-full px-2 py-1 rounded bg-surface border border-line font-mono text-ink disabled:opacity-50"
                      />
                    </label>
                  ))}
                </div>

                <div className="flex items-start gap-4">
                  <SensitivityFieldPreview
                    points={customPreviewPoints}
                    maxEccentricityDeg={Math.max(
                      settings.customGrid.extentXDeg,
                      settings.customGrid.extentYDeg,
                    ) + 4}
                    size={180}
                    caption="Preview (right eye)"
                  />
                  <div className="space-y-1 text-[11px] text-muted pt-4">
                    <div>
                      <span className="text-body font-mono">
                        {countCustomGridPoints(settings.customGrid)}
                      </span>{' '}
                      test locations
                    </div>
                    <div>
                      Coverage ±{settings.customGrid.extentXDeg}° × ±
                      {settings.customGrid.extentYDeg}°
                    </div>
                    <div>
                      Spacing {settings.customGrid.spacingXDeg}° × {settings.customGrid.spacingYDeg}°
                    </div>
                  </div>
                </div>
              </div>
            )}
          </fieldset>
          )}

          {/* Background shade */}
          <fieldset className="space-y-1">
            <legend className="text-body">Background shade</legend>
            <div className="flex gap-3 pt-1">
              {(['dark', 'medium', 'light'] as const).map(shade => (
                <label key={shade} className="flex items-center gap-1.5 capitalize">
                  <input
                    type="radio"
                    name="adv-bg-shade"
                    value={shade}
                    checked={settings.backgroundShade === shade}
                    onChange={() => update('backgroundShade', shade)}
                    className="accent-amber-500"
                  />
                  {shade}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Reset / Export / Import */}
          <div className="pt-2 border-t border-line space-y-2">
            <div className="flex gap-4 flex-wrap">
              <button
                type="button"
                onClick={reset}
                className="text-xs text-muted hover:text-body underline decoration-dotted"
              >
                Reset to defaults
              </button>
              <button
                type="button"
                onClick={() => exportSettingsAsFile(settings)}
                className="text-xs text-muted hover:text-body underline decoration-dotted"
              >
                Export settings
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs text-muted hover:text-body underline decoration-dotted"
              >
                Import settings
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                aria-label="Import settings JSON file"
                onChange={handleImport}
                className="sr-only"
              />
            </div>
            {importError && (
              <p role="alert" className="text-xs text-red-400">
                Import failed: {importError}
              </p>
            )}
            {importSuccess && !importError && (
              <p role="status" className="text-xs text-green-400">
                Settings imported.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
