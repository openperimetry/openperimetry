// Registry of clinic workstations and their one-time calibration.
// Each entry pins the bank-card pixel width (always needed) plus
// optional defaults for viewing distance and brightness floor that are
// stable for a given physical setup. Reaction time deliberately stays
// per-test since it varies per participant.
//
// Storage shape: `{ activeId, screens[] }`. We migrate from the older
// single-record shape transparently so users who already calibrated
// don't lose their saved value.

const STORAGE_KEY = 'vfc-screen-calibration'

export interface SavedScreen {
  id: string
  label: string
  cardWidthPx: number
  screenWidthPx: number
  screenHeightPx: number
  devicePixelRatio: number
  savedAt: string
  viewingDistanceCm?: number
  brightnessFloor?: number
}

interface ScreensState {
  activeId: string | null
  screens: SavedScreen[]
}

const EMPTY_STATE: ScreensState = { activeId: null, screens: [] }

function currentScreenFingerprint() {
  return {
    screenWidthPx: typeof screen !== 'undefined' ? screen.width : window.innerWidth,
    screenHeightPx: typeof screen !== 'undefined' ? screen.height : window.innerHeight,
    devicePixelRatio: window.devicePixelRatio ?? 1,
  }
}

function isValidScreen(raw: unknown): raw is SavedScreen {
  if (!raw || typeof raw !== 'object') return false
  const s = raw as Partial<SavedScreen>
  return (
    typeof s.id === 'string' &&
    typeof s.label === 'string' &&
    typeof s.cardWidthPx === 'number' &&
    Number.isFinite(s.cardWidthPx) &&
    s.cardWidthPx >= 100 &&
    s.cardWidthPx <= 1000 &&
    typeof s.screenWidthPx === 'number' &&
    typeof s.screenHeightPx === 'number'
  )
}

function sanitizeScreen(raw: SavedScreen): SavedScreen {
  const viewingDistanceCm =
    typeof raw.viewingDistanceCm === 'number' &&
    raw.viewingDistanceCm >= 20 &&
    raw.viewingDistanceCm <= 100
      ? raw.viewingDistanceCm
      : undefined
  const brightnessFloor =
    typeof raw.brightnessFloor === 'number' &&
    raw.brightnessFloor >= 0 &&
    raw.brightnessFloor <= 1
      ? raw.brightnessFloor
      : undefined
  return {
    id: raw.id,
    label: raw.label,
    cardWidthPx: raw.cardWidthPx,
    screenWidthPx: raw.screenWidthPx,
    screenHeightPx: raw.screenHeightPx,
    devicePixelRatio: typeof raw.devicePixelRatio === 'number' ? raw.devicePixelRatio : 1,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
    viewingDistanceCm,
    brightnessFloor,
  }
}

function readState(): ScreensState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_STATE
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return EMPTY_STATE

    // Multi-screen shape
    const candidate = parsed as Partial<ScreensState> & Partial<SavedScreen>
    if (Array.isArray(candidate.screens)) {
      const screens = candidate.screens.filter(isValidScreen).map(sanitizeScreen)
      const activeId =
        typeof candidate.activeId === 'string' && screens.some(s => s.id === candidate.activeId)
          ? candidate.activeId
          : screens[0]?.id ?? null
      return { activeId, screens }
    }

    // Legacy single-record shape — migrate transparently.
    if (typeof candidate.cardWidthPx === 'number') {
      const fp = currentScreenFingerprint()
      const legacy: SavedScreen = sanitizeScreen({
        id: 'default',
        label: 'This workstation',
        cardWidthPx: candidate.cardWidthPx,
        screenWidthPx: candidate.screenWidthPx ?? fp.screenWidthPx,
        screenHeightPx: candidate.screenHeightPx ?? fp.screenHeightPx,
        devicePixelRatio: candidate.devicePixelRatio ?? fp.devicePixelRatio,
        savedAt: candidate.savedAt ?? new Date().toISOString(),
        viewingDistanceCm: candidate.viewingDistanceCm,
        brightnessFloor: candidate.brightnessFloor,
      })
      const next: ScreensState = { activeId: legacy.id, screens: [legacy] }
      writeState(next)
      return next
    }

    return EMPTY_STATE
  } catch {
    return EMPTY_STATE
  }
}

function writeState(state: ScreensState): ScreensState {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  return state
}

export function listScreens(): SavedScreen[] {
  return readState().screens
}

export function getActiveScreen(): SavedScreen | null {
  const state = readState()
  if (!state.activeId) return null
  const screen = state.screens.find(s => s.id === state.activeId)
  if (!screen) return null
  const fp = currentScreenFingerprint()
  // If the display geometry has changed, the saved bank-card mapping is
  // no longer trustworthy — surface null so the calibration screen runs
  // from scratch instead of silently using a stale ratio.
  if (
    screen.screenWidthPx !== fp.screenWidthPx ||
    screen.screenHeightPx !== fp.screenHeightPx
  ) {
    return null
  }
  return screen
}

export function getActiveScreenId(): string | null {
  return readState().activeId
}

export interface NewScreenInput {
  label: string
  cardWidthPx: number
  viewingDistanceCm?: number
  brightnessFloor?: number
}

function makeScreenId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${slug || 'screen'}-${rand}`
}

export function addScreen(input: NewScreenInput): SavedScreen {
  const state = readState()
  const fp = currentScreenFingerprint()
  const screen: SavedScreen = sanitizeScreen({
    id: makeScreenId(input.label),
    label: input.label.trim() || 'Workstation',
    cardWidthPx: input.cardWidthPx,
    ...fp,
    savedAt: new Date().toISOString(),
    viewingDistanceCm: input.viewingDistanceCm,
    brightnessFloor: input.brightnessFloor,
  })
  writeState({ activeId: screen.id, screens: [...state.screens, screen] })
  return screen
}

export function updateScreen(id: string, patch: Partial<NewScreenInput>): SavedScreen | null {
  const state = readState()
  const idx = state.screens.findIndex(s => s.id === id)
  if (idx < 0) return null
  const existing = state.screens[idx]
  const fp = currentScreenFingerprint()
  // Re-stamp the fingerprint on every update so the entry tracks the
  // current display. If the user recalibrates the card on a swapped
  // monitor, we trust the freshly-measured value over the stored one.
  const updated: SavedScreen = sanitizeScreen({
    ...existing,
    label: patch.label?.trim() || existing.label,
    cardWidthPx: patch.cardWidthPx ?? existing.cardWidthPx,
    viewingDistanceCm: 'viewingDistanceCm' in patch ? patch.viewingDistanceCm : existing.viewingDistanceCm,
    brightnessFloor: 'brightnessFloor' in patch ? patch.brightnessFloor : existing.brightnessFloor,
    ...fp,
    savedAt: new Date().toISOString(),
  })
  const screens = [...state.screens]
  screens[idx] = updated
  writeState({ ...state, screens })
  return updated
}

export function setActiveScreen(id: string | null): void {
  const state = readState()
  if (id && !state.screens.some(s => s.id === id)) return
  writeState({ ...state, activeId: id })
}

export function deleteScreen(id: string): void {
  const state = readState()
  const screens = state.screens.filter(s => s.id !== id)
  const activeId = state.activeId === id ? (screens[0]?.id ?? null) : state.activeId
  writeState({ activeId, screens })
}

export function clearActiveScreen(): void {
  const state = readState()
  writeState({ ...state, activeId: null })
}

export function clearAllScreens(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/** Replace the locally-stored registry with a server-provided one.
 *  Used by the clinician portal to seed local state from the API on
 *  sign-in, so a clinician switching machines sees their saved
 *  workstations. Display geometry from the server is preserved
 *  verbatim — getActiveScreen() will still filter out entries whose
 *  fingerprint doesn't match the current display. */
export function replaceAllScreens(input: {
  screens: SavedScreen[]
  activeId: string | null
}): void {
  const sanitized = input.screens.map(s => sanitizeScreen({ ...s }))
  const activeId =
    input.activeId && sanitized.some(s => s.id === input.activeId)
      ? input.activeId
      : sanitized[0]?.id ?? null
  writeState({ activeId, screens: sanitized })
}
