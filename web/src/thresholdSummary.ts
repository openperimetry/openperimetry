/**
 * Derive compact, privacy-safe summary stats from a threshold-mode static
 * run. Used to enrich `test_completed` telemetry so we can see at a glance
 * whether the test is producing plausible dB distributions — without
 * uploading the full point map.
 *
 * All fields are stringified because `trackEvent` meta values are stored
 * as DynamoDB string attributes (see `api/src/ddbStore.ts::trackEvent`).
 */

import type { TestPoint } from './types'

/** Count + distribution summary. All numeric outputs are already rounded. */
export interface ThresholdSummary {
  /** Total points with a measured threshold. */
  n: number
  /** Points flagged as likely absolute scotoma (threshold ≤ 0 dB). */
  scotomaN: number
  /** Points pinned at the dim ceiling (≥ 34 dB). Usually means healthy. */
  ceilingN: number
  /** Arithmetic mean of thresholdDb across measured points. */
  meanDb: number
  /** Median thresholdDb. */
  medianDb: number
  /** Count in [0, 10) dB. */
  bin0to10: number
  /** Count in [10, 20) dB. */
  bin10to20: number
  /** Count in [20, 30) dB. */
  bin20to30: number
  /** Count in [30, ∞) dB — every threshold ≥ 30. (The staircase clamps to
   *  ≤ 35 dB, so in normal runs the effective top of this bin is 35; an
   *  out-of-range import above 35 still lands here, hence the open interval.) */
  bin30plus: number
}

export function summarizeThresholdPoints(points: TestPoint[]): ThresholdSummary {
  const dbs: number[] = []
  for (const p of points) {
    if (typeof p.thresholdDb === 'number' && Number.isFinite(p.thresholdDb)) {
      dbs.push(p.thresholdDb)
    }
  }
  const n = dbs.length
  if (n === 0) {
    return {
      n: 0, scotomaN: 0, ceilingN: 0,
      meanDb: 0, medianDb: 0,
      bin0to10: 0, bin10to20: 0, bin20to30: 0, bin30plus: 0,
    }
  }
  let scotomaN = 0, ceilingN = 0
  let bin0to10 = 0, bin10to20 = 0, bin20to30 = 0, bin30plus = 0
  let sum = 0
  for (const db of dbs) {
    sum += db
    if (db <= 0) scotomaN++
    if (db >= 34) ceilingN++
    if (db < 10) bin0to10++
    else if (db < 20) bin10to20++
    else if (db < 30) bin20to30++
    else bin30plus++
  }
  const sorted = [...dbs].sort((a, b) => a - b)
  const mid = Math.floor(n / 2)
  const medianDb = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return {
    n,
    scotomaN,
    ceilingN,
    meanDb: Math.round((sum / n) * 10) / 10,
    medianDb: Math.round(medianDb * 10) / 10,
    bin0to10,
    bin10to20,
    bin20to30,
    bin30plus,
  }
}

/** Render a {@link ThresholdSummary} into a `Record<string,string>` ready to
 *  hand to `trackEvent(..., meta)`. Keys are kept short to stay well under
 *  DynamoDB's 400 KB item limit even if the event accumulates many fields. */
export function thresholdSummaryToMeta(s: ThresholdSummary): Record<string, string> {
  return {
    thN: String(s.n),
    thScotomaN: String(s.scotomaN),
    thCeilingN: String(s.ceilingN),
    thMeanDb: String(s.meanDb),
    thMedianDb: String(s.medianDb),
    thBin0_10: String(s.bin0to10),
    thBin10_20: String(s.bin10to20),
    thBin20_30: String(s.bin20to30),
    // Wire key kept as `thBin30_35` for telemetry continuity, but the value is
    // the open-ended [30, ∞) bin (`bin30plus`), not a closed [30, 35] count.
    thBin30_35: String(s.bin30plus),
  }
}
