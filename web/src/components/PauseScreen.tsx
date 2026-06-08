/**
 * Shared pause-screen overlay for the running tests.
 *
 * Static and Goldmann previously each shipped their own copy of the
 * paused-phase JSX — the layouts had drifted just enough to make
 * cross-test consistency a maintenance worry (one branch had the
 * Restart wired up, the other didn't, the keyboard hint was identical
 * but duplicated, the copy for the progress line was almost-but-not-
 * quite the same). One component, four callbacks, and an `extra` slot
 * for the test-specific bit in the middle (Goldmann's speed toggle).
 *
 * The Esc/Space hint hides on touch-only devices because there's no
 * keyboard there — `isMobileDevice` mirrors the same UA+touch sniff
 * both test components already used.
 */

import type { ReactNode } from 'react'

const isMobileDevice =
  typeof navigator !== 'undefined'
  && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  && navigator.maxTouchPoints > 0

interface Props {
  /** Background colour class — passed through from the test
   *  component so the pause overlay keeps the same shade the user
   *  was just looking at (advanced settings can vary this). */
  bgClass: string
  /** One-line progress copy. Static says "X / Y points measured",
   *  Goldmann says "X of Y points completed". The wording belongs to
   *  the caller; this component just renders it. */
  progressText: string
  /** 0–100 — width of the teal progress bar. */
  progressPct: number
  onResume: () => void
  onRestart: () => void
  onStop: () => void
  onQuit: () => void
  /** Optional content rendered between the progress bar and the
   *  action buttons. Goldmann uses this for the in-pause speed
   *  toggle; Static leaves it undefined. */
  extra?: ReactNode
}

export function PauseScreen({
  bgClass,
  progressText,
  progressPct,
  onResume,
  onRestart,
  onStop,
  onQuit,
  extra,
}: Props) {
  return (
    <div className={`min-h-screen ${bgClass} text-white flex items-center justify-center select-none p-6`}>
      <div className="text-center space-y-6 max-w-sm w-full">
        <h1 className="text-2xl font-semibold">Paused</h1>
        <p className="text-gray-400 text-sm">{progressText}</p>

        {/* Progress bar — teal signals forward motion (owned by teal
            in this app's palette; amber is for selection / primary-
            action). */}
        <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-teal transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        {extra}

        <div className="space-y-3 pt-2">
          <button
            onClick={onResume}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >
            Resume
          </button>
          <button
            onClick={onRestart}
            className="w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
          >
            Restart from the beginning
          </button>
          <button
            onClick={onStop}
            className="w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
          >
            Stop test &amp; view results
          </button>
          <button onClick={onQuit} className="text-gray-500 hover:text-gray-300 text-sm">
            Quit without viewing results
          </button>
        </div>

        {!isMobileDevice && (
          <p className="text-xs text-gray-600">
            Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Esc</kbd> or{' '}
            <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Space</kbd> to resume
          </p>
        )}
      </div>
    </div>
  )
}
