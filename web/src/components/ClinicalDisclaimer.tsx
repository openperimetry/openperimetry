/**
 * Clinical disclaimer banner for home and result pages.
 * Home variant is collapsible — shows a single line summary with
 * a "Read more" toggle to reduce visual weight on the landing page.
 */
import { useState } from 'react'

interface Props {
  /** 'home' shows the collapsible version, 'results' shows a compact reminder */
  variant?: 'home' | 'results'
}

export function ClinicalDisclaimer({ variant = 'home' }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (variant === 'results') {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-surface px-4 py-3">
        <div className="flex items-start gap-2.5">
          <svg className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
          </svg>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Self-monitoring tool only — not a clinical diagnostic device. Always consult your ophthalmologist.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/[0.05] bg-surface/60 px-4 py-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 text-left"
        aria-expanded={expanded}
      >
        <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
        </svg>
        <span className="text-xs text-zinc-400 flex-1">
          Self-monitoring tool — not a replacement for clinical perimetry.
        </span>
        <svg className={`w-3.5 h-3.5 text-zinc-600 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-3 space-y-2 text-xs text-zinc-500 leading-relaxed border-t border-white/[0.05] pt-3">
          <p>
            Results may differ from clinical Goldmann perimetry due to screen limitations, uncontrolled viewing distance, and the absence of standardized testing conditions.
          </p>
          <p>
            Always consult your ophthalmologist for diagnosis and treatment decisions. This tool is intended to help track changes between clinical visits.
          </p>
        </div>
      )}
    </div>
  )
}
