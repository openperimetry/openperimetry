import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { THEME_KEY, getPreference, resolveTheme, cyclePreference, applyTheme } from './theme'

// The vitest environment is 'node' (see vitest.config.ts), so we stub the
// browser globals that this module needs. Pattern mirrors advancedSettings.test.ts.

let store: Record<string, string> = {}
let dataTheme: string | null = null
let colorScheme = ''
let metaThemeColor = ''

const localStorageStub = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = v },
  removeItem: (k: string) => { delete store[k] },
  clear: () => { store = {} },
  key: () => null,
  length: 0,
}

const documentElementStub = {
  getAttribute: (name: string) => (name === 'data-theme' ? dataTheme : null),
  setAttribute: (name: string, value: string) => { if (name === 'data-theme') dataTheme = value },
  removeAttribute: (name: string) => { if (name === 'data-theme') dataTheme = null },
  style: { set colorScheme(v: string) { colorScheme = v }, get colorScheme() { return colorScheme } },
}

const metaElementStub = {
  getAttribute: (name: string) => (name === 'content' ? metaThemeColor : null),
  setAttribute: (name: string, value: string) => { if (name === 'content') metaThemeColor = value },
}

const documentStub = {
  documentElement: documentElementStub,
  querySelector: (selector: string) =>
    selector === 'meta[name="theme-color"]' ? metaElementStub : null,
}

describe('theme', () => {
  beforeEach(() => {
    store = {}
    dataTheme = null
    colorScheme = ''
    metaThemeColor = ''
    vi.stubGlobal('localStorage', localStorageStub)
    vi.stubGlobal('document', documentStub)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to system when nothing stored', () => {
    expect(getPreference()).toBe('system')
  })

  it('reads a stored preference', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    expect(getPreference()).toBe('dark')
  })

  it('resolves explicit preferences directly', () => {
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('resolves system to the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('cycles system -> light -> dark -> system', () => {
    expect(cyclePreference('system')).toBe('light')
    expect(cyclePreference('light')).toBe('dark')
    expect(cyclePreference('dark')).toBe('system')
  })

  it('applyTheme writes data-theme and persists the preference', () => {
    applyTheme('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(metaElementStub.getAttribute('content')).toBe('#0b1220')
  })
})
