/**
 * Shared Fixation Accuracy (FA) and False-Positive Response Rate (FPRR)
 * computation used by both the in-app Interpretation panel and the PDF
 * export so the two renderers can never disagree. Reference ranges from
 * Dzwiniel et al., PLoS ONE 2017, 12(10):e0186224 — n=21 healthy controls.
 */

import type { TestResult } from './types'
import { RELIABILITY_REFERENCE_RANGES } from './testDefaults'

export interface FaResult {
  /** Correctly ignored blindspot catch trials. */
  correct: number
  /** Total catch trials presented. */
  presented: number
  /** Fixation accuracy as a percentage. */
  percent: number
  /** Qualitative band — 'normal' | 'borderline' | 'low'. */
  band: 'normal' | 'borderline' | 'low'
  bandLabel: string
}

export interface FprrResult {
  /** False-positive responses (catch-trial presses + ISI presses). */
  falsePositives: number
  /** All response-like actions (true positives + false positives). */
  total: number
  /** FPRR as a percentage. */
  percent: number
  band: 'normal' | 'elevated' | 'high'
  bandLabel: string
}

export interface ReliabilityIndicesResult {
  fa: FaResult | null
  fprr: FprrResult | null
}

/** Compute FA/FPRR from a test result's raw counters. Returns null for
 *  each metric when the required counters are absent — the caller decides
 *  whether to render nothing or show a "not recorded" placeholder. */
export function computeReliabilityIndices(
  result: Pick<TestResult, 'reliabilityIndices'>,
): ReliabilityIndicesResult {
  const r = result.reliabilityIndices
  if (!r || r.catchTrialsPresented <= 0) {
    return { fa: null, fprr: null }
  }

  const {
    catchTrialsPresented,
    catchTrialsFalsePositive,
    falsePositiveIsiPresses,
    truePositiveResponses,
  } = r

  const faCorrect = catchTrialsPresented - catchTrialsFalsePositive
  const faPct = (faCorrect / catchTrialsPresented) * 100
  const faMin = RELIABILITY_REFERENCE_RANGES.faPercent.min
  const faBand: FaResult['band'] =
    faPct >= faMin ? 'normal' : faPct >= 60 ? 'borderline' : 'low'
  const faBandLabel =
    faBand === 'normal'
      ? 'within normal range'
      : faBand === 'borderline'
      ? 'borderline'
      : 'below normal — fixation loss suspected'

  const fa: FaResult = {
    correct: faCorrect,
    presented: catchTrialsPresented,
    percent: faPct,
    band: faBand,
    bandLabel: faBandLabel,
  }

  const fprrNumerator = catchTrialsFalsePositive + falsePositiveIsiPresses
  const fprrDenominator = fprrNumerator + truePositiveResponses
  let fprr: FprrResult | null = null
  if (fprrDenominator > 0) {
    const fprrPct = (fprrNumerator / fprrDenominator) * 100
    const fprrMax = RELIABILITY_REFERENCE_RANGES.fprrPercent.max
    const fprrBand: FprrResult['band'] =
      fprrPct <= fprrMax ? 'normal' : fprrPct <= 10 ? 'elevated' : 'high'
    const fprrBandLabel =
      fprrBand === 'normal'
        ? 'within normal range'
        : fprrBand === 'elevated'
        ? 'elevated'
        : 'high — trigger-happy responses suspected'
    fprr = {
      falsePositives: fprrNumerator,
      total: fprrDenominator,
      percent: fprrPct,
      band: fprrBand,
      bandLabel: fprrBandLabel,
    }
  }

  return { fa, fprr }
}
