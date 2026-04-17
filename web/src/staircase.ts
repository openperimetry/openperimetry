/** Lower/upper bounds of presentable dB on a consumer LCD. 0 dB = full
 *  brightness (caller can't go any brighter); 35 dB is roughly the dimmest
 *  intensity we can render reliably once the calibrated `brightnessFloor`
 *  is subtracted. Values outside this range are clamped during the
 *  staircase walk — clamping is NOT treated as a reversal. */
export const DB_MIN_THRESH = 0
export const DB_MAX_THRESH = 35

const REVERSALS_REQUIRED = 2

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
  /** dB values at each reversal, in chronological order. Length 0 until
   *  the first reversal, length 2 at termination. */
  reversals: number[]
  /** `true` once `REVERSALS_REQUIRED` reversals have been collected.
   *  Once `true`, `stepStaircase` is a no-op (returns the same reference). */
  done: boolean
  /** Estimated threshold — mean of the two reversal dBs. Populated only
   *  when `done` is `true`; `undefined` while the staircase is still
   *  running. */
  thresholdDb?: number
}

function clamp(db: number): number {
  return Math.max(DB_MIN_THRESH, Math.min(DB_MAX_THRESH, db))
}

/** Start a new staircase at the given prior dB estimate. */
export function initStaircase(priorDb: number): StaircaseState {
  return {
    currentDb: clamp(priorDb),
    stepDb: 4,
    lastResponse: null,
    reversals: [],
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
  if (reversals.length >= REVERSALS_REQUIRED) {
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
  const delta = seen ? stepDb : -stepDb
  return {
    currentDb: clamp(s.currentDb + delta),
    stepDb,
    lastResponse: seen,
    reversals,
    done: false,
  }
}
