/**
 * Accessible navigation components for visually impaired users.
 * Large touch targets (min 44px), high contrast, clear labels.
 */

interface BackButtonProps {
  onClick: () => void
  label?: string
}

export function BackButton({ onClick, label = 'Back' }: BackButtonProps) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] text-sm font-medium text-zinc-300 hover:text-white bg-surface hover:bg-elevated rounded-xl transition-all border border-white/[0.06] hover:border-white/[0.12] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base"
      aria-label={label}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      {label}
    </button>
  )
}
