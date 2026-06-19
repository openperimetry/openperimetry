import { useEffect, useState } from 'react'
import {
  type ThemePreference,
  type ResolvedTheme,
  getPreference,
  applyTheme,
  cyclePreference,
  prefersDark,
  resolveTheme,
} from '../theme'

/**
 * Three-state theme control (System → Light → Dark). Defaults to System,
 * which follows the OS and updates live when the OS theme changes. Sits in
 * the homepage top-right header next to the GitHub link.
 */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>(() => getPreference())
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(getPreference(), prefersDark()),
  )

  // Re-apply on mount (covers the case where this is the first JS to run after
  // the no-flash bootstrap) and whenever the preference changes.
  useEffect(() => {
    applyTheme(pref)
    setResolved(resolveTheme(pref, prefersDark()))
  }, [pref])

  // When following the system, react to live OS theme changes.
  useEffect(() => {
    if (pref !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => {
      applyTheme('system')
      setResolved(resolveTheme('system', e.matches))
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref])
  const label =
    pref === 'system'
      ? `Theme: System (currently ${resolved}). Activate for Light.`
      : pref === 'light'
        ? 'Theme: Light. Activate for Dark.'
        : 'Theme: Dark. Activate for System.'

  return (
    <button
      type="button"
      onClick={() => setPref((p) => cyclePreference(p))}
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-muted hover:text-ink hover:bg-subtle-2 transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
    >
      {pref === 'system' ? (
        <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      ) : pref === 'light' ? (
        <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  )
}
