/** Lower/upper bounds of presentable dB on a consumer LCD. 0 dB = full
 *  brightness (caller can't go any brighter); 35 dB is roughly the dimmest
 *  intensity we can render reliably once the calibrated `brightnessFloor`
 *  is subtracted. Values outside this range are clamped during the
 *  staircase walk — clamping is NOT treated as a reversal.
 *
 *  Floor/ceiling termination: if the staircase is pinned at a bound and
 *  the response keeps it pinned (two consecutive misses at floor, or two
 *  consecutive sees at ceiling) the staircase terminates at the bound.
 *  Without this, a fully blind point cycles forever at DB_MIN_THRESH
 *  because clamping never creates a reversal — the progress bar stalls
 *  and the test never ends. */
export const DB_MIN_THRESH = 0
export const DB_MAX_THRESH = 35

/** Default number of reversals required before the staircase terminates.
 *  Callers can override this per-staircase via `initStaircase`'s second
 *  argument — the speed-preset machinery in `testDefaults.ts` uses that
 *  override to run the Fast preset at 2 reversals (noisier, shorter
 *  exam) and the Normal/Relaxed presets at 4 reversals (comparable to
 *  the ~9-trial-per-location budget used by Dzwiniel et al. 2017,
 *  PLoS ONE 12(10):e0186224, for their SuperFast reference protocol).
 *  We expose this constant so the UI (progress ring) has a single
 *  default to reason about when no preset has been resolved yet. */
export const REVERSALS_REQUIRED = 2

export interface StaircaseState {
  /** Current dB level to show at the next presentation. Always clamped
   *  to `[DB_MIN_THRESH, DB_MAX_THRESH]`. */
  currentDb: number
  /** Step size for the next move. Starts at 4, drops to 2 after the
   *  first reversal, and never returns to 4. */
  stepDb: 4 | 2
  /** Response to the *previous* presentation (`true` = seen,
   *  `false` = not seen). `null` before the first presentation; used to
   *  detect direction flips. */
  lastResponse: boolean | null
  /** dB values at each reversal, in chronological order. Grows up to
   *  `reversalsRequired` entries; threshold uses the last two. */
  reversals: number[]
  /** Per-staircase reversal budget — set at `initStaircase` time so the
   *  speed preset can choose a shorter (faster, noisier) or longer
   *  (clinical-grade) walk per location. */
  reversalsRequired: number
  /** `true` once `reversalsRequired` reversals have been collected.
   *  Once `true`, `stepStaircase` is a no-op (returns the same reference). */
  done: boolean
  /** Estimated threshold — mean of the last two reversal dBs. The
   *  earlier reversals are discarded because the starting prior biases
   *  them; averaging the final pair gives the most stable estimate.
   *  Populated only when `done` is `true`; `undefined` while the
   *  staircase is still running. */
  thresholdDb?: number
}

function clamp(db: number): number {
  return Math.max(DB_MIN_THRESH, Math.min(DB_MAX_THRESH, db))
}

/** Start a new staircase at the given prior dB estimate. `reversalsRequired`
 *  defaults to `REVERSALS_REQUIRED` (2) for backward compatibility; callers
 *  that want a longer, more clinically-precise walk (e.g. the Normal speed
 *  preset) pass 4. */
export function initStaircase(
  priorDb: number,
  reversalsRequired: number = REVERSALS_REQUIRED,
): StaircaseState {
  if (!Number.isInteger(reversalsRequired) || reversalsRequired < 2) {
    throw new Error(`reversalsRequired must be an integer ≥ 2 (got ${reversalsRequired})`)
  }
  return {
    currentDb: clamp(priorDb),
    stepDb: 4,
    lastResponse: null,
    reversals: [],
    reversalsRequired,
    done: false,
  }
}

/** Advance the staircase with the response to the most recent
 *  presentation. A reversal is recorded whenever the response direction
 *  flips (seen↔not-seen). The first reversal halves the step from 4 to
 *  2 dB; the second terminates the staircase with
 *  `thresholdDb = (rev1 + rev2) / 2`. Pure and idempotent once done. */
export function stepStaircase(s: StaircaseState, seen: boolean): StaircaseState {
  if (s.done) return s
  const reversed = s.lastResponse !== null && s.lastResponse !== seen
  let reversals = s.reversals
  let stepDb: 4 | 2 = s.stepDb
  if (reversed) {
    reversals = [...s.reversals, s.currentDb]
    if (stepDb === 4) stepDb = 2
  }
  if (reversals.length >= s.reversalsRequired) {
    const [a, b] = reversals.slice(-2)
    return {
      ...s,
      lastResponse: seen,
      reversals,
      stepDb,
      done: true,
      thresholdDb: (a + b) / 2,
    }
  }
  // Stuck-at-bound termination. Two consecutive responses pushing past
  // the same bound → we're clamped forever with no hope of a reversal,
  // so record the bound as the threshold and finish. See header comment
  // for why this matters (progress bar / termination).
  const stuckFloor = s.currentDb <= DB_MIN_THRESH && !seen && s.lastResponse === false
  const stuckCeiling = s.currentDb >= DB_MAX_THRESH && seen && s.lastResponse === true
  if (stuckFloor || stuckCeiling) {
    return {
      ...s,
      lastResponse: seen,
      reversals,
      stepDb,
      done: true,
      thresholdDb: s.currentDb,
    }
  }
  const delta = seen ? stepDb : -stepDb
  return {
    ...s,
    currentDb: clamp(s.currentDb + delta),
    stepDb,
    lastResponse: seen,
    reversals,
    done: false,
  }
}
