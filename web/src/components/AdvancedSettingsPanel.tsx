/**
 * Collapsible "Advanced test settings" panel, rendered inside the
 * CalibrationScreen's final "Ready to test" step. Closed by default so
 * casual users don't see it; reads and writes through the global
 * AdvancedSettings context so changes persist across reloads.
 *
 * See `docs/superpowers/plans/2026-04-18-advanced-settings.md` (Task B.1).
 */

import { useRef, useState } from 'react'
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

interface Props {
  /** The user's currently-selected speed preset. Used to auto-fill
   *  the speed-override fields when the user first enables the toggle. */
  speedPreset?: SpeedPresetName
}

export function AdvancedSettingsPanel({ speedPreset = 'normal' }: Props) {
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

  return (
    <div className="bg-surface/60 border border-white/[0.06] rounded-2xl">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="advanced-settings-body"
        className="w-full flex items-center justify-between px-4 py-3 text-left text-xs text-zinc-400 hover:text-zinc-200"
      >
        <span>Advanced test settings (optional)</span>
        <span aria-hidden className="font-mono text-zinc-500">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div
          id="advanced-settings-body"
          className="px-4 pb-4 pt-1 space-y-4 text-xs text-zinc-400 border-t border-white/[0.04]"
        >
          {/* Catch-trial cadence */}
          <div className="space-y-1">
            <label htmlFor="adv-catch" className="block text-zinc-300">
              Catch-trial cadence
              <span className="ml-1 text-zinc-500 font-normal">
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
              className="w-24 px-2 py-1 rounded bg-base border border-white/[0.08] font-mono text-white"
            />
          </div>

          {/* Fixation-alert duration */}
          <div className="space-y-1">
            <label htmlFor="adv-alert-ms" className="block text-zinc-300">
              Fixation-alert duration
              <span className="ml-1 text-zinc-500 font-normal">(ms; 0 = disabled)</span>
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
              className="w-24 px-2 py-1 rounded bg-base border border-white/[0.08] font-mono text-white"
            />
          </div>

          {/* Fixation-alert message */}
          <div className="space-y-1">
            <label htmlFor="adv-alert-msg" className="block text-zinc-300">
              Fixation-alert message
            </label>
            <input
              id="adv-alert-msg"
              type="text"
              maxLength={200}
              value={settings.fixationAlertMessage}
              onChange={e => update('fixationAlertMessage', e.target.value)}
              className="w-full px-2 py-1 rounded bg-base border border-white/[0.08] text-white"
            />
          </div>

          {/* Speed preset */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-zinc-300">
              <input
                type="checkbox"
                checked={settings.speedPreset.override}
                onChange={e => toggleSpeedOverride(e.target.checked)}
                className="accent-amber-500"
              />
              Override speed-preset timings
              <span className="text-zinc-500 font-normal">(static test only)</span>
            </label>

            <div className="grid grid-cols-2 gap-2 pl-6">
              {(['stimulusMs', 'responseMs', 'gapMinMs', 'gapMaxMs'] as const).map(f => (
                <label key={f} className="space-y-1">
                  <span className="block text-zinc-400 text-[11px]">{f}</span>
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
                    className="w-full px-2 py-1 rounded bg-base border border-white/[0.08] font-mono text-white disabled:opacity-50"
                  />
                </label>
              ))}
            </div>
          </div>

          {/* Background shade */}
          <fieldset className="space-y-1">
            <legend className="text-zinc-300">Background shade</legend>
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
          <div className="pt-2 border-t border-white/[0.04] space-y-2">
            <div className="flex gap-4 flex-wrap">
              <button
                type="button"
                onClick={reset}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline decoration-dotted"
              >
                Reset to defaults
              </button>
              <button
                type="button"
                onClick={() => exportSettingsAsFile(settings)}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline decoration-dotted"
              >
                Export settings
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline decoration-dotted"
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
