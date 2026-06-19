/**
 * Theme preference + resolution. The user picks one of three preferences;
 * "system" follows the OS. We persist the *preference* but always apply a
 * resolved concrete value ("light" | "dark") to <html data-theme> so the CSS
 * only needs a single [data-theme="dark"] override (see index.css). The
 * no-flash bootstrap in index.html does the same resolution before paint.
 */
export const THEME_KEY = 'vfc-theme'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export function getPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* private mode / no storage */
  }
  return 'system'
}

export function prefersDark(): boolean {
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(pref: ThemePreference, osDark: boolean): ResolvedTheme {
  if (pref === 'dark') return 'dark'
  if (pref === 'light') return 'light'
  return osDark ? 'dark' : 'light'
}

export function cyclePreference(pref: ThemePreference): ThemePreference {
  return pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system'
}

/** Persist the preference and apply the resolved theme to the document. */
export function applyTheme(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* ignore */
  }
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(pref, prefersDark())
  const root = document.documentElement
  root.setAttribute('data-theme', resolved)
  root.style.colorScheme = resolved
  // Keep the browser chrome (mobile status bar) in sync.
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b1220' : '#f4f7fb')
}
