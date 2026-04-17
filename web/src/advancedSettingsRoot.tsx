/**
 * `<AdvancedSettingsRoot>` — the single component export for the
 * advanced-settings module. Kept in its own file so the companion
 * `./advancedSettings.ts` has no component exports; that's a requirement
 * of Vite's react-refresh ESLint rule, which wants each file to export
 * either only components or only non-components.
 */

import { useCallback, useState, type ReactNode } from 'react'
import {
  ADVANCED_SETTINGS_CTX,
  ADVANCED_SETTINGS_SET_CTX,
  loadAdvancedSettings,
  saveAdvancedSettings,
  type AdvancedSettings,
} from './advancedSettings'

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
    <ADVANCED_SETTINGS_SET_CTX.Provider value={update}>
      <ADVANCED_SETTINGS_CTX.Provider value={settings}>{children}</ADVANCED_SETTINGS_CTX.Provider>
    </ADVANCED_SETTINGS_SET_CTX.Provider>
  )
}
