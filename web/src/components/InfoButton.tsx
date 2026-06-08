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
 * The popover is positioned `top-full mt-2` and horizontally
 * centred on the trigger; if it overflows the viewport on a narrow
 * screen the max-width clamps to 80vw so it stays visible. Not yet
 * smart enough to auto-flip above when the bottom is clipped — add
 * floating-ui later if it becomes a real problem.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

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
  const wrapperRef = useRef<HTMLSpanElement>(null)

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
        type="button"
        onClick={e => {
          // Stop propagation so this doesn't also fire the
          // surrounding tab/pill's onClick.
          e.stopPropagation()
          setOpen(v => !v)
        }}
        aria-label={`Info about ${label}`}
        aria-expanded={open}
        className={`w-4 h-4 rounded-full bg-white/[0.06] hover:bg-white/[0.14] text-zinc-300 hover:text-white text-[10px] font-semibold leading-none flex items-center justify-center transition-colors ${className}`.trim()}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 w-64 max-w-[80vw] rounded-lg border border-white/[0.08] bg-surface px-3 py-2.5 text-xs leading-relaxed text-zinc-200 shadow-2xl text-left normal-case tracking-normal"
          onClick={e => e.stopPropagation()}
        >
          {children}
        </span>
      )}
    </span>
  )
}
