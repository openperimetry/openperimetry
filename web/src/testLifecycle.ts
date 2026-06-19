/**
 * Shared test-lifecycle guards + abort-telemetry classification.
 *
 * Both StaticTest and GoldmannTest run the same 7–8 min/eye exam and used
 * to each hand-roll their own `pagehide → test_aborted` beacon. That had two
 * problems the abort-funnel investigation surfaced:
 *
 *  1. **`pagehide` over-counted benign teardown.** The handler had no
 *     `event.persisted` (bfcache) skip, so backgrounding a tab — which on
 *     mobile fires `pagehide` on every app-switch / screen-lock and on
 *     desktop fires when the page enters the back/forward cache — logged a
 *     full-weight `test_aborted` even though the in-memory test kept running
 *     and could still complete. The "two early aborts then two completions
 *     on one device" telemetry signature is this artefact, not a real quit.
 *
 *  2. **Accidental teardown had no guard.** Losing fullscreen (the browser
 *     eats the first Esc to exit fullscreen, so the app's pause never ran),
 *     switching tabs (stimuli kept flashing to a hidden tab and scored as
 *     misses), and a reflexive Cmd+R all silently destroyed the run.
 *
 * Centralising the wiring here means Static and Goldmann — and any future
 * test component — get identical behaviour and can't drift.
 */

import { useEffect, useRef } from 'react'

/** Classification of how a page is being left, used to keep the abort
 *  metric honest. */
export interface PageLeaveInfo {
  /** `true` when the page is entering the back/forward cache. It is NOT
   *  being destroyed and will very likely be restored, so this must never
   *  count as a test abort. */
  bfcache: boolean
  /** `document.visibilityState` at the moment of leave (`visible` |
   *  `hidden` | `unknown`). A `hidden` terminal leave is a real
   *  background-and-gone; a `visible` one is a deliberate close/navigate. */
  visibilityState: string
  /** How the document was originally loaded (`navigate` | `reload` |
   *  `back_forward` | `prerender` | `unknown`). Informational — surfaces
   *  reload-heavy sessions in aggregate. */
  navType: string
}

/** Inspect a `pagehide` event (and the live document/performance state) to
 *  decide whether the leave is benign (bfcache) or a genuine teardown, and
 *  capture the context needed to segment the abort metric afterwards.
 *  Pure aside from reading globals — safe to unit test by passing a stub. */
export function classifyPageLeave(
  e?: Pick<PageTransitionEvent, 'persisted'> | null,
): PageLeaveInfo {
  const bfcache = e?.persisted === true
  let visibilityState = 'unknown'
  try {
    if (typeof document !== 'undefined') visibilityState = document.visibilityState
  } catch { /* non-browser env */ }
  let navType = 'unknown'
  try {
    const entries = typeof performance !== 'undefined' && performance.getEntriesByType
      ? (performance.getEntriesByType('navigation') as PerformanceNavigationTiming[])
      : []
    if (entries[0]?.type) navType = entries[0].type
  } catch { /* not supported */ }
  return { bfcache, visibilityState, navType }
}

/** Flatten leave classification into string→string meta for the event
 *  beacon. `leaveKind` is the one-field summary a dashboard can group on:
 *  exclude `bfcache`, treat `hidden`/`terminal` as candidate real aborts. */
export function pageLeaveMeta(info: PageLeaveInfo): Record<string, string> {
  return {
    bfcache: String(info.bfcache),
    visibilityState: info.visibilityState,
    navType: info.navType,
    leaveKind: info.bfcache
      ? 'bfcache'
      : info.visibilityState === 'hidden'
        ? 'hidden'
        : 'terminal',
  }
}

/** Read whether the document is currently in any vendor's fullscreen. */
export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false
  const doc = document as Document & { webkitFullscreenElement?: Element | null }
  return !!(document.fullscreenElement || doc.webkitFullscreenElement)
}

export interface ActiveTestGuards {
  /** Is a scored run in progress and not yet completed/aborted? Gates the
   *  pagehide abort beacon and the beforeunload confirm. Read fresh on
   *  every event so the latest refs are honoured. */
  isRunActive: () => boolean
  /** Is the test actively presenting stimuli (so losing fullscreen or the
   *  tab being hidden must force a clean pause)? Typically
   *  `phase === 'testing' || phase === 'practice'`. */
  isPresenting: () => boolean
  /** A genuine page teardown (NOT bfcache) happened while the run was
   *  active. Caller fires the abort beacon and is responsible for dedupe. */
  onTeardown: (info: PageLeaveInfo) => void
  /** The run should auto-pause: fullscreen was lost or the tab was hidden
   *  mid-presentation. Caller routes this into its existing pause path. */
  onAutoPause: () => void
}

/** Install every accidental-abort / teardown guard for an active test, once,
 *  and keep them pointed at the latest callbacks via a ref. Used identically
 *  by StaticTest and GoldmannTest so all teardown scenarios behave the same:
 *    - pagehide  → abort beacon, but bfcache is skipped (de-noise)
 *    - visibilitychange (hidden) → auto-pause while presenting
 *    - fullscreenchange (exited) → auto-pause while presenting (makes the
 *      reflexive Esc land on the pause screen instead of a broken live test)
 *    - beforeunload → confirm dialog while the run is active (desktop) */
export function useActiveTestGuards(opts: ActiveTestGuards): void {
  const ref = useRef(opts)
  // Keep the callbacks current without re-subscribing the listeners. Updated
  // in an effect (not during render) so we don't write a ref mid-render; the
  // guards fire from async events that always run after this commits.
  useEffect(() => {
    ref.current = opts
  })
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      const info = classifyPageLeave(e)
      if (info.bfcache) return
      if (!ref.current.isRunActive()) return
      ref.current.onTeardown(info)
    }
    const onVisibility = () => {
      if (
        typeof document !== 'undefined'
        && document.visibilityState === 'hidden'
        && ref.current.isPresenting()
      ) {
        ref.current.onAutoPause()
      }
    }
    const onFullscreenChange = () => {
      if (!isFullscreen() && ref.current.isPresenting()) ref.current.onAutoPause()
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!ref.current.isRunActive()) return
      e.preventDefault()
      // Legacy spec requirement; modern Chrome shows its own generic copy.
      e.returnValue = ''
    }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('webkitfullscreenchange', onFullscreenChange)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
    // Install once — `ref` keeps callbacks current without re-subscribing.
  }, [])
}
