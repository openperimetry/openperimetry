/**
 * Shared reliability-score computation used by both the in-app
 * Interpretation panel and the PDF export so the two renderers can never
 * disagree on what score a given test produced.
 *
 * The score is 100 minus a series of penalty factors, each capped so no
 * single metric can dominate. See inline comments for the clinical
 * reasoning behind each penalty.
 */

import type { TestPoint, StimulusKey } from './types'
import { ISOPTER_ORDER } from './types'

export interface ReliabilityFactor {
  name: string
  penalty: number
  detail: string
}

export interface ReliabilityResult {
  score: number       // 0-100
  label: string       // High / Moderate / Low / Very low
  color: string       // tailwind text-* class matching the band
  factors: ReliabilityFactor[]
}

/** Compute the reliability score for a Goldmann-style kinetic test.
 *  Returns the same result whether called from the in-app panel or the
 *  PDF export — any drift between the two would be a bug. */
export function computeReliability(
  points: TestPoint[],
  areas: Partial<Record<StimulusKey, number>>,
): ReliabilityResult {
  let score = 100
  const factors: ReliabilityFactor[] = []

  // 1. Isopter ordering consistency — mild overlaps get small penalty,
  //    dramatic reversals get larger penalty. Adjacent overlap is very common in RP
  //    (brightness vs size sensitivity differences), so use lenient thresholds.
  let mildReversals = 0
  let majorReversals = 0
  for (let i = 0; i < ISOPTER_ORDER.length - 1; i++) {
    const outer = ISOPTER_ORDER[i]
    const inner = ISOPTER_ORDER[i + 1]
    const outerArea = areas[outer]
    const innerArea = areas[inner]
    if (outerArea == null || innerArea == null) continue
    if (innerArea > outerArea * 3.0) {
      majorReversals++
    } else if (innerArea > outerArea * 1.5) {
      mildReversals++
    }
  }
  if (majorReversals > 0) {
    const penalty = majorReversals * 12
    score -= penalty
    factors.push({
      name: 'Isopter ordering',
      penalty,
      detail: `${majorReversals} isopter pair(s) dramatically reversed (inner > 2× outer)`,
    })
  }
  if (mildReversals > 0) {
    const penalty = mildReversals * 3
    score -= penalty
    factors.push({
      name: 'Isopter overlap',
      penalty,
      detail: `${mildReversals} adjacent isopter pair(s) overlap slightly — common in constricted RP fields`,
    })
  }

  // 2. Boundary noise — residual from a 2-harmonic Fourier fit of the
  //    boundary, normalised by mean radius.
  //
  //    Any smooth directional variation (circular, elliptical, superior/
  //    inferior altitudinal, nasal/temporal asymmetry) fits into the mean
  //    + 1-cycle + 2-cycle harmonics exactly and leaves zero residual.
  //    Only HIGH-frequency variation — point-to-point jitter that can't
  //    be explained by any smooth field shape — shows up in the residual.
  //    This is the actual signature of attention lapses, fixation drift,
  //    or random false-positives/negatives, which is what reliability is
  //    supposed to measure.
  //
  //    Previous implementations penalised overall CV (stddev / mean) and
  //    then 3-point local curvature, both of which treated real clinical
  //    asymmetry as noise and cost users with genuine altitudinal defects
  //    ~20 reliability points for perfectly consistent tests.
  const noiseFractions: number[] = []
  for (const stim of ISOPTER_ORDER) {
    const detected = points
      .filter(p => p.stimulus === stim && p.detected)
      .sort((a, b) => a.meridianDeg - b.meridianDeg)
    if (detected.length < 6) continue
    const n = detected.length
    const rs = detected.map(p => p.eccentricityDeg)
    const thetas = detected.map(p => (p.meridianDeg * Math.PI) / 180)
    const mean = rs.reduce((s, v) => s + v, 0) / n
    if (mean < 2) continue
    // Fourier coefficients up to 2nd harmonic (DC + 2 × {cos, sin}).
    let a1 = 0, b1 = 0, a2 = 0, b2 = 0
    for (let i = 0; i < n; i++) {
      a1 += rs[i] * Math.cos(thetas[i])
      b1 += rs[i] * Math.sin(thetas[i])
      a2 += rs[i] * Math.cos(2 * thetas[i])
      b2 += rs[i] * Math.sin(2 * thetas[i])
    }
    a1 *= 2 / n; b1 *= 2 / n; a2 *= 2 / n; b2 *= 2 / n
    // Sum of squared residuals from the fit.
    let sumSq = 0
    for (let i = 0; i < n; i++) {
      const fit = mean
        + a1 * Math.cos(thetas[i])
        + b1 * Math.sin(thetas[i])
        + a2 * Math.cos(2 * thetas[i])
        + b2 * Math.sin(2 * thetas[i])
      const d = rs[i] - fit
      sumSq += d * d
    }
    const rms = Math.sqrt(sumSq / n)
    noiseFractions.push(rms / mean)
  }
  if (noiseFractions.length > 0) {
    const avgNoise = noiseFractions.reduce((s, v) => s + v, 0) / noiseFractions.length
    // Only flag residuals > 35% — below that, residual can come from real
    // high-order shape structure like screen-edge clipping of a peanut
    // field, which isn't noise but isn't describable by 2 harmonics. The
    // metric is intentionally gentle: at 50% residual you lose 8 points,
    // at 60% you lose 12. Truly random jitter runs above 70% and triggers
    // the hard cap.
    if (avgNoise > 0.35) {
      const penalty = Math.min(15, Math.round((avgNoise - 0.35) * 50))
      score -= penalty
      factors.push({
        name: 'Boundary noise',
        penalty,
        detail: `Boundary residual after a smooth-shape fit averages ${(avgNoise * 100).toFixed(0)}% of the mean radius. Only high point-to-point jitter is penalised — legitimate directional asymmetry is absorbed by the fit.`,
      })
    }
  }

  // 3. Sufficient data points
  const totalDetected = points.filter(p => p.detected).length
  if (totalDetected < 30) {
    const penalty = Math.min(20, Math.round((30 - totalDetected) * 1.5))
    score -= penalty
    factors.push({
      name: 'Data points',
      penalty,
      detail: `Only ${totalDetected} detected points (≥30 recommended for reliable mapping)`,
    })
  }

  // 4. Meridian coverage — check if detected points span enough directions
  const uniqueMeridians = new Set(points.filter(p => p.detected).map(p => p.meridianDeg))
  if (uniqueMeridians.size < 8) {
    const penalty = Math.min(15, (8 - uniqueMeridians.size) * 3)
    score -= penalty
    factors.push({
      name: 'Meridian coverage',
      penalty,
      detail: `Detected points span only ${uniqueMeridians.size} meridians (≥8 recommended)`,
    })
  }

  // 5. Detection rate consistency — very low overall detection may indicate attention issues
  const totalPoints = points.length
  const overallRate = totalPoints > 0 ? totalDetected / totalPoints : 1
  if (overallRate < 0.40) {
    const penalty = Math.min(15, Math.round((0.40 - overallRate) * 50))
    score -= penalty
    factors.push({
      name: 'Detection rate',
      penalty,
      detail: `Overall detection rate is ${(overallRate * 100).toFixed(0)}% — low rates may indicate attention issues`,
    })
  }

  // 6. Duplicate readings ratio (high = many re-tests needed = noisy responses)
  //    A detected + not-detected pair at the same position is normal boundary mapping, not a retest.
  //    Only count same-status duplicates as true retests.
  const meridianStimPairs = new Map<string, number>()
  for (const p of points) {
    const key = `${p.stimulus}-${p.meridianDeg}-${p.detected}`
    meridianStimPairs.set(key, (meridianStimPairs.get(key) ?? 0) + 1)
  }
  const multiReadings = [...meridianStimPairs.values()].filter(c => c > 1).length
  const retestRatio = meridianStimPairs.size > 0 ? multiReadings / meridianStimPairs.size : 0
  if (retestRatio > 0.30) {
    const penalty = Math.min(10, Math.round((retestRatio - 0.30) * 30))
    score -= penalty
    factors.push({
      name: 'Retest rate',
      penalty,
      detail: `${(retestRatio * 100).toFixed(0)}% of positions needed re-testing (outlier corrections)`,
    })
  }

  score = Math.max(0, Math.min(100, score))

  let label: string
  let color: string
  if (score >= 85) {
    label = 'High'
    color = 'text-green-400'
  } else if (score >= 65) {
    label = 'Moderate'
    color = 'text-yellow-400'
  } else if (score >= 40) {
    label = 'Low'
    color = 'text-orange-400'
  } else {
    label = 'Very low'
    color = 'text-red-400'
  }

  return { score, label, color, factors }
}
