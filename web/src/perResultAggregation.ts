/**
 * Per-grid-point aggregation across multiple TestResults for the same eye.
 *
 * Used to render test-retest variance maps (Dzwiniel et al. 2017, Fig. 5):
 * when a user has ≥2 static tests recorded, this tells us — for each probed
 * location — what fraction of presentations were detected (mean) and how
 * consistent the detection was across sessions (stdev). A low-SD defect is
 * more likely real than a high-SD one.
 *
 * Contract:
 *   - Key format: `"meridianDeg,eccentricityDeg"`, each component rounded
 *     to 1 decimal place.
 *   - Only sensitivity points are aggregated. Catch-trial points (used for
 *     fixation-loss detection) are excluded.
 *   - A point with n=1 has stdev=0 — this is descriptive, not inferential.
 *   - Population standard deviation is used (divide by n, not n-1).
 *   - Mixing test types (e.g. static vs. goldmann) throws — different
 *     sampling strategies produce incomparable detection rates.
 */

import type { TestResult } from './types'

export interface PerPointAggregate {
  /** Mean detection rate across results at this point (0 to 1). */
  mean: number
  /** Population standard deviation of the detection rate (0 to 0.5). */
  stdev: number
  /** Number of results contributing a measurement at this point. */
  n: number
}

function keyOf(meridianDeg: number, eccentricityDeg: number): string {
  // Round to 1 decimal place, drop trailing ".0" so whole numbers key as
  // "0" rather than "0.0" (readable and stable across sessions).
  const m = Math.round(meridianDeg * 10) / 10
  const e = Math.round(eccentricityDeg * 10) / 10
  const stringify = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
  return `${stringify(m)},${stringify(e)}`
}

export function aggregatePerPoint(
  results: TestResult[],
): Map<string, PerPointAggregate> {
  if (results.length === 0) return new Map()

  // Reject mismatched test types — static and goldmann sample different
  // stimulus ladders and can't be meaningfully averaged.
  const firstType = results[0].testType
  for (const r of results) {
    if (r.testType !== firstType) {
      throw new Error(
        `aggregatePerPoint: cannot aggregate across mismatched test type ` +
          `(${firstType} vs ${r.testType})`,
      )
    }
  }

  const samples = new Map<string, number[]>()
  for (const r of results) {
    for (const p of r.points) {
      if (p.catchTrial) continue
      const k = keyOf(p.meridianDeg, p.eccentricityDeg)
      const arr = samples.get(k)
      const value = p.detected ? 1 : 0
      if (arr) arr.push(value)
      else samples.set(k, [value])
    }
  }

  const out = new Map<string, PerPointAggregate>()
  for (const [k, values] of samples) {
    const n = values.length
    const mean = values.reduce((a, b) => a + b, 0) / n
    const variance =
      values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n
    const stdev = Math.sqrt(variance)
    out.set(k, { mean, stdev, n })
  }
  return out
}
