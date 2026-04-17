/**
 * Clinical disclaimer banner for home and result pages.
 *
 * The banner starts collapsed with just the headline claim
 * ("This tool has not been validated against a clinical perimeter.")
 * and a Read more toggle; the two-paragraph detail expands inline on
 * click. Keeping the full caveat always-visible was crowding out the
 * primary CTA on the landing page, so we surface the headline (which
 * is the part users must see) and let the rest expand on demand.
 */

import { useState } from 'react'

interface Props {
  /** 'home' = landing-page styling, 'results' = more compact for result pages */
  variant?: 'home' | 'results'
}

export function ClinicalDisclaimer({ variant = 'home' }: Props) {
  const [expanded, setExpanded] = useState(false)

  const frameClass =
    variant === 'home'
      ? 'rounded-xl border border-white/[0.05] bg-surface/60 px-4 py-3'
      : 'rounded-xl border border-white/[0.06] bg-surface px-4 py-3'
  const textClass = 'text-xs text-zinc-400 leading-relaxed'

  return (
    <div className={frameClass}>
      <div className="flex items-start gap-2.5">
        <svg
          className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
            clipRule="evenodd"
          />
        </svg>
        <div className={`${textClass} space-y-2 flex-1`}>
          <p>
            <span className="text-zinc-200 font-medium">
              This tool has not been validated against a clinical perimeter.
            </span>
            {!expanded && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-white hover:decoration-zinc-400 transition-colors"
                  aria-expanded={expanded}
                >
                  Read more
                </button>
              </>
            )}
            {expanded && (
              <>
                {' '}
                Results may differ from clinical perimetry due to screen limitations,
                uncontrolled viewing distance, and the absence of standardized testing
                conditions.
              </>
            )}
          </p>
          {expanded && (
            <>
              <p>
                Always consult your ophthalmologist for diagnosis and treatment decisions.
                Use this tool to notice changes in your own field — not as a reliable clinical indicator.
              </p>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-white hover:decoration-zinc-400 transition-colors"
                aria-expanded={expanded}
              >
                Show less
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
