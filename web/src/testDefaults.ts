/**
 * Central source of truth for user-visible test parameters that previously
 * lived as module-local constants inside individual test components.
 *
 * Exported here so the methodology page can render a "current test
 * parameters" table by importing the same values the code uses, and so the
 * future "Advanced test settings" plan (2026-04-18-advanced-settings.md)
 * can thread user overrides through one well-defined set of defaults.
 *
 * Existing parameters that are NOT duplicated here — they already live in
 * more specific modules:
 *   - `MIN_RESPONSE_MS` and similar psychophysics thresholds → `./constants`
 *   - Blindspot anatomical coordinates → `./blindspot`
 *   - Stimulus sizes and intensities (V4e etc.) → `./types` (`STIMULI`)
 */

/** Timing bundle for one speed preset. */
export interface SpeedPresetTimings {
  stimulusMs: number
  responseMs: number
  gapMinMs: number
  gapMaxMs: number
}

/** Full speed-preset bundle including the staircase reversal budget.
 *  Separate from `SpeedPresetTimings` because the runtime override UI
 *  (Advanced Settings) only exposes the timing fields — reversal count
 *  is tied to the home-screen fast/normal/relaxed toggle. */
export interface SpeedPresetConfig extends SpeedPresetTimings {
  /** Reversals required per location. Fewer = shorter exam, noisier
   *  per-point threshold. Passed to `initStaircase(priorDb, ...)`. */
  reversalsRequired: number
}

/** The three built-in speed presets. */
export type SpeedPresetName = 'relaxed' | 'slow' | 'normal'

/** How often a stimulus presentation is swapped for a blindspot catch trial.
 *  Default per Dzwiniel et al., PLoS ONE 2017 (12(10):e0186224), their
 *  `monitorFixationEveryXStimuli` parameter. Overridable at runtime by
 *  the Advanced Settings feature (see 2026-04-18-advanced-settings.md). */
export const CATCH_TRIAL_EVERY_N: number = 10

/** Duration (ms) the fixation-loss alert overlay is shown when a catch
 *  trial false positive is recorded. Set to 0 to disable the overlay.
 *  Overridable at runtime by Advanced Settings. */
export const FIXATION_LOSS_ALERT_MS: number = 1200

/** Text displayed in the fixation-loss alert overlay. Overridable at
 *  runtime by Advanced Settings. */
export const FIXATION_LOSS_ALERT_MESSAGE: string = 'Keep your eye on the fixation point'

/** Speed-preset bundles for the static test. Each preset controls:
 *  - stimulusMs: how long the stimulus is visible
 *  - responseMs: extra response window after the stimulus clears
 *  - gapMinMs / gapMaxMs: the inter-stimulus gap is uniformly random within
 *    [gapMinMs, gapMaxMs] — this is the jitter that prevents anticipation
 *  - reversalsRequired: how many 4-2 dB staircase reversals per location
 *    before we accept the threshold. Normal uses 2 (noisier, shortest
 *    exam); Slow/Relaxed use 4 (~9 trials per location, matching the
 *    9-level brightness vector Dzwiniel et al. 2017 used for their
 *    SuperFast reference protocol).
 *  Timing fields are overridable at runtime via Advanced Settings;
 *  `reversalsRequired` is fixed per home-screen speed toggle. */
export const SPEED_PRESETS: Record<SpeedPresetName, SpeedPresetConfig> = {
  relaxed: { stimulusMs: 600, responseMs: 1800, gapMinMs: 500, gapMaxMs: 900, reversalsRequired: 4 },
  slow:    { stimulusMs: 500, responseMs: 1400, gapMinMs: 350, gapMaxMs: 650, reversalsRequired: 4 },
  normal:  { stimulusMs: 200, responseMs: 1000, gapMinMs: 700, gapMaxMs: 900, reversalsRequired: 2 },
}

/** Shape of a reliability-index reference range. */
export interface ReliabilityRange {
  min: number
  max: number
}

/** Reliability-index reference ranges from Dzwiniel et al., PLoS ONE 2017
 *  12(10):e0186224, n=21 healthy controls aged 22–28. Used to annotate
 *  Fixation Accuracy (FA) and False-Positive Response Rate (FPRR) in the
 *  PDF, HistoryView, and methodology page. */
export const RELIABILITY_REFERENCE_RANGES: {
  faPercent: ReliabilityRange
  fprrPercent: ReliabilityRange
  citation: string
} = {
  /** Fixation Accuracy — % of catch trials correctly ignored. */
  faPercent: { min: 79, max: 99 },
  /** False-Positive Response Rate — % of key presses with no stimulus shown. */
  fprrPercent: { min: 0.3, max: 2.3 },
  citation: 'Dzwiniel et al., PLoS ONE 2017, 12(10):e0186224',
}
