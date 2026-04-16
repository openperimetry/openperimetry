// web/src/constants.ts — clinical and operational magic numbers used
// across components. One place to tune timing, bounds, and retry
// behaviour. Clinical constants are marked "clinical:" in their comment
// so forks know not to touch them casually.

// ── Goldmann kinetic test ───────────────────────────────────────────
export const GOLDMANN = {
  /** clinical: button presses faster than this are treated as anticipation / false starts */
  MIN_RESPONSE_MS: 150,
  /** clinical: degrees beyond the predicted boundary at which a refinement probe starts */
  BOUNDARY_OFFSET_DEG: 8,
  /** clinical: eccentricity gap between adjacent meridians that triggers an adaptive refill */
  ADAPTIVE_THRESHOLD_DEG: 5,
  /** clinical: fraction of neighbour-average a point may deviate before being flagged as an outlier */
  OUTLIER_FACTOR: 0.40,
} as const

// ── Static threshold test ──────────────────────────────────────────
export const STATIC_TEST = {
  /** clinical: button presses faster than this are treated as anticipation / false starts */
  MIN_RESPONSE_MS: 150,
  /** clinical: skip the central fixation area when generating the hex grid */
  MIN_ECCENTRICITY_DEG: 1.5,
  /** clinical: hard ceiling on testable eccentricity regardless of screen extent */
  MAX_TESTABLE_ECCENTRICITY_DEG: 80,
  /** ms between successive stimuli in a multi-point burst */
  BURST_STAGGER_MS: 150,
} as const

// ── Calibration ────────────────────────────────────────────────────
export const CALIBRATION = {
  /** clinical: default reaction-time allowance in ms when the user hasn't run RT trials */
  DEFAULT_REACTION_TIME_MS: 250,
} as const

// ── API retry/backoff ─────────────────────────────────────────────
export const API = {
  /** Max retry attempts on transient 5xx errors */
  MAX_RETRIES: 3,
  /** Base delay between retries in ms (multiplied by 2^attempt in exponential backoff) */
  RETRY_DELAY_MS: 1000,
} as const
