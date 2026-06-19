/**
 * Small `i` icon button that toggles a popover with explanatory copy.
 *
 * Used in places where a control label alone doesn't carry enough
 * meaning for a first-time visitor (e.g. "Goldmann" vs "Static"
 * tabs, "Quick" vs "Normal" vs "Slow" pacing). Tap once to open,
 * tap outside or press Esc to dismiss. Stops propagation on the
 * trigger click so the surrounding control (which may itself be a
 * button or tab) doesn't also fire when the user just wants info.
 *
 * The popover is horizontally centred on the trigger and opens below
 * it by default; if there isn't enough room below (e.g. the pace
 * info button near the bottom of the card, where a downward popover
 * would render on top of the Begin-test button) it flips to open
 * upward instead. The max-width clamps to 80vw so it stays visible
 * on narrow screens.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

// Hard cap on popover height (px). Tall popovers (e.g. the three-row
// pace explainer) otherwise sprawl down across the card and cover the
// Begin-test CTA below it. Capped + internally scrollable keeps the
// popover compact enough to sit cleanly above or below its trigger.
const MAX_POPOVER_HEIGHT = 280

// Estimate used to choose a side before the real (capped) height is
// measured on the first paint. Matches the cap so the very first
// placement guess already accounts for a full-height popover.
const ESTIMATED_POPOVER_HEIGHT = MAX_POPOVER_HEIGHT

interface Props {
  /** Used for the trigger's aria-label ("Info about <label>"). */
  label: string
  /** Popover body. Plain text or JSX. */
  children: ReactNode
  /** Optional extra classes on the trigger (for sizing tweaks). */
  className?: string
}

export function InfoButton({ label, children, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom')
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLSpanElement>(null)

  // Decide whether the popover opens below (default) or above the
  // trigger. Uses the real popover height once it's rendered, falling
  // back to an estimate for the very first paint. Flips upward only
  // when the bottom is genuinely cramped AND there's more room above,
  // so a popover never ends up clipped off the top either.
  const updatePlacement = () => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const popoverHeight = popoverRef.current?.offsetHeight || ESTIMATED_POPOVER_HEIGHT
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const needed = popoverHeight + 12
    // Bias toward flipping up: only open downward when there's
    // comfortable clearance below, so a popover near the bottom of the
    // card doesn't crowd the viewport edge or the Begin-test CTA that
    // sits just under it. If below is tight but the popover fits above,
    // flip; only as a last resort pick the larger of two cramped gaps.
    const BIAS = 28
    let next: 'top' | 'bottom'
    if (spaceBelow >= needed + BIAS) next = 'bottom'
    else if (spaceAbove >= needed) next = 'top'
    else next = spaceAbove > spaceBelow ? 'top' : 'bottom'
    setPlacement(next)
  }

  // Re-measure after the popover mounts (its real height is only known then)
  // and whenever the viewport changes while it's open. The onClick handler
  // already sets an initial placement from the estimated height before opening,
  // so the popover paints in roughly the right spot; this refines it with the
  // real measured height on the next frame. The refinement is deferred via rAF
  // (rather than called synchronously in the effect) so it isn't a synchronous
  // in-effect setState that could cascade renders.
  useLayoutEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(updatePlacement)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={wrapperRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={e => {
          // Stop propagation so this doesn't also fire the
          // surrounding tab/pill's onClick.
          e.stopPropagation()
          // Compute placement up-front so the popover appears in the
          // right spot on its first paint (the layout effect then
          // refines it with the real measured height).
          if (!open) updatePlacement()
          setOpen(v => !v)
        }}
        aria-label={`Info about ${label}`}
        aria-expanded={open}
        className={`w-4 h-4 rounded-full bg-subtle-2 hover:bg-line text-ink hover:text-ink text-[10px] font-semibold leading-none flex items-center justify-center transition-colors ${className}`.trim()}
      >
        i
      </button>
      {open && (
        <span
          ref={popoverRef}
          role="tooltip"
          style={{ maxHeight: MAX_POPOVER_HEIGHT }}
          className={`absolute left-1/2 -translate-x-1/2 z-50 w-64 max-w-[80vw] overflow-y-auto overscroll-contain rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-xs leading-relaxed text-slate-100 shadow-2xl text-left normal-case tracking-normal ${
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
          }`}
          onClick={e => e.stopPropagation()}
        >
          {children}
        </span>
      )}
    </span>
  )
}
