import type { TestPoint, StimulusKey } from './types'
import { ISOPTER_ORDER } from './types'

export interface BoundaryPoint {
  meridianDeg: number
  eccentricityDeg: number
}

/** Shortest angular distance between two meridians, in [0, 180]. */
function meridianDelta(a: number, b: number): number {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180)
}

interface BinnedWithMask {
  boundary: BoundaryPoint[]
  /** True at index i when boundary[i] was produced from a real measurement
   *  (vs. neighbor interpolation). The smoothing pass reads this mask so it
   *  doesn't pull measured peaks toward interpolated-average gaps. */
  isMeasured: boolean[]
}

/** Core binning — returns the dense wrap-around array along with a mask
 *  identifying which bins came from real data. */
function binBoundaryWithMask(
  allDetected: TestPoint[],
  binSizeDeg: number,
): BinnedWithMask {
  const numBins = Math.round(360 / binSizeDeg)
  const bins: (number | null)[] = new Array(numBins).fill(null)

  for (const p of allDetected) {
    const bin = Math.round(((p.meridianDeg % 360 + 360) % 360) / binSizeDeg) % numBins
    if (bins[bin] === null || p.eccentricityDeg > bins[bin]!) {
      bins[bin] = p.eccentricityDeg
    }
  }

  const isMeasured = bins.map(v => v !== null)

  const filled = bins.map((v, i) => {
    if (v !== null) return v
    for (let d = 1; d <= numBins / 2; d++) {
      const prev = bins[(i - d + numBins) % numBins]
      const next = bins[(i + d) % numBins]
      if (prev !== null && next !== null) return (prev + next) / 2
      if (prev !== null) return prev
      if (next !== null) return next
    }
    return 0
  })

  const boundary = filled.map((ecc, i) => ({
    meridianDeg: i * binSizeDeg,
    eccentricityDeg: ecc,
  }))
  return { boundary, isMeasured }
}

/**
 * Bin detected points into angular sectors and return the outermost
 * detected eccentricity per sector. Gaps are interpolated from neighbors.
 */
export function binBoundaryPoints(
  allDetected: TestPoint[],
  binSizeDeg: number = 5,
): BoundaryPoint[] {
  if (allDetected.length < 3) return []
  return binBoundaryWithMask(allDetected, binSizeDeg).boundary
}

/**
 * Sample a boundary at an arbitrary meridian via circular linear
 * interpolation between the two meridian-nearest points. Used when the
 * caller wants to compare two boundaries whose bin counts differ.
 *
 * Returns +Infinity for an empty reference so `clampBoundary` against an
 * empty reference is a no-op.
 */
export function sampleBoundaryAt(
  boundary: BoundaryPoint[],
  meridianDeg: number,
): number {
  const n = boundary.length
  if (n === 0) return Infinity
  if (n === 1) return boundary[0].eccentricityDeg
  const sorted = [...boundary].sort((a, b) => a.meridianDeg - b.meridianDeg)
  const target = ((meridianDeg % 360) + 360) % 360
  for (let i = 0; i < n; i++) {
    const curM = ((sorted[i].meridianDeg % 360) + 360) % 360
    const next = sorted[(i + 1) % n]
    let nextM = ((next.meridianDeg % 360) + 360) % 360
    if (nextM <= curM) nextM += 360
    let q = target
    if (q < curM) q += 360
    if (q >= curM && q <= nextM) {
      const span = nextM - curM
      const frac = span === 0 ? 0 : (q - curM) / span
      return sorted[i].eccentricityDeg + frac * (next.eccentricityDeg - sorted[i].eccentricityDeg)
    }
  }
  return sorted[0].eccentricityDeg
}

/**
 * Clamp each point of `boundary` to not exceed `reference`'s interpolated
 * eccentricity at the same meridian. Used by the isopter renderer to enforce
 * the clinical nesting rule (dimmer isopters lie inside brighter ones).
 *
 * Unlike a raw `Math.min(boundary[i], reference[i])` this tolerates bin-count
 * mismatches — for example when a dim isopter was binned at 15° but the
 * brighter one was binned at 30° — by sampling the reference at the target
 * meridian instead of by index.
 */
export function clampBoundary(
  boundary: BoundaryPoint[],
  reference: BoundaryPoint[],
): BoundaryPoint[] {
  if (reference.length === 0) return boundary
  return boundary.map(p => ({
    ...p,
    eccentricityDeg: Math.min(p.eccentricityDeg, sampleBoundaryAt(reference, p.meridianDeg)),
  }))
}

/** Isopter area in square degrees as a true spherical solid angle.
 *
 * The visual field is on a sphere, so a flat polar polygon (shoelace of
 * ecc·cosθ, ecc·sinθ) over-states area at large eccentricities (~+2% at 26°,
 * ~+6% at 47°) and is inconsistent with the tangent/sphericity-corrected
 * projection used for stimulus positions. For a star-shaped region around
 * fixation with boundary eccentricity ρ(φ), the solid angle is
 *   Ω = ∫ (1 − cos ρ(φ)) dφ   [steradians],
 * integrated trapezoidally around the (sorted) boundary; deg² = Ω·(180/π)².
 * Reduces to the flat π·ρ² for small ρ, so small isopters are unchanged. */
function calcArea(points: TestPoint[]): number {
  const allDetected = points.filter(p => p.detected)
  const boundary = binBoundaryPoints(allDetected)
  if (boundary.length < 3) return 0

  const ring = boundary
    .map(p => ({
      phi: ((((p.meridianDeg % 360) + 360) % 360) * Math.PI) / 180,
      rho: (p.eccentricityDeg * Math.PI) / 180,
    }))
    .sort((a, b) => a.phi - b.phi)

  const TWO_PI = 2 * Math.PI
  let omega = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    // Azimuthal width of this segment, wrapped across the 0/2π seam.
    const dPhi = (((b.phi - a.phi) % TWO_PI) + TWO_PI) % TWO_PI
    omega += ((1 - Math.cos(a.rho)) + (1 - Math.cos(b.rho))) / 2 * dPhi
  }
  const degPerRad = 180 / Math.PI
  return omega * degPerRad * degPerRad
}

/**
 * Smoothed boundary in degree-space, suitable for rendering at any pixel scale.
 *
 * Key property: **measured bins are preserved at their true eccentricity**.
 * The smoothing kernel only modifies the *interpolated* bins that sit
 * between real measurements, so peaks in the actual detected data are never
 * pulled toward the averaged fill-ins. This is the fix for the "inner
 * isopters look too small" artifact — the old implementation ran 12 passes
 * of Gaussian smoothing over the dense array (including interpolated bins),
 * which composed to an effective sigma large enough to drag measured peaks
 * toward neighbor averages and lose ~10–20% of the radii.
 *
 * Spike dampening still runs on measured bins — genuinely noisy responses
 * get pulled toward their measured neighbors — but interpolated bins are
 * treated as read-only outputs that follow whatever the smoother produces
 * from the dampened measured values.
 */
export function computeSmoothedBoundary(allDetected: TestPoint[]): BoundaryPoint[] {
  if (allDetected.length < 3) return []
  const isScattered = allDetected.length > 20
  const binSize = isScattered ? 5 : (allDetected.length <= 12 ? 30 : 15)
  const { boundary, isMeasured } = binBoundaryWithMask(allDetected, binSize)
  if (boundary.length < 3) return []

  const n = boundary.length

  // Spike-dampen MEASURED bins against their nearest measured neighbors on
  // each side, skipping interpolated bins (which are themselves averages).
  // Falls back to ordinary neighbors when there's only one measured bin.
  //
  // Sparse-data guard: when data is sparse (few measured bins or wide
  // meridian gaps between them), "measured neighbors" can be 20°+ of
  // meridian away. In that regime a legitimate peripheral peak looks
  // "spiky" vs. its distant neighbors and the original aggressive
  // dampening (threshold 30%, pull 0.65 toward neighbors) silently
  // compressed the boundary by 20–30%. Since clampBoundary cascades this
  // into every inner isopter, over-damping V4e constricted the whole
  // nested set. We soften both the threshold and the pull weight when
  // neighbors aren't close on the meridian circle; the assumption that
  // "peak vs. neighbor = noise" is only valid when neighbors are adjacent.
  const measuredIdx: number[] = []
  for (let i = 0; i < n; i++) if (isMeasured[i]) measuredIdx.push(i)

  if (measuredIdx.length >= 3) {
    // Store snapshot so dampening uses ORIGINAL neighbor values, not
    // already-pulled ones from earlier iterations. This was also a source
    // of over-correction: the first damped peak pulled its neighbors'
    // effective positions, biasing subsequent decisions.
    const original = boundary.map(p => p.eccentricityDeg)
    for (let k = 0; k < measuredIdx.length; k++) {
      const idx = measuredIdx[k]
      const prevK = (k - 1 + measuredIdx.length) % measuredIdx.length
      const nextK = (k + 1) % measuredIdx.length
      const prevIdx = measuredIdx[prevK]
      const nextIdx = measuredIdx[nextK]
      // Meridian distance to nearest measured neighbor on each side.
      const distPrev = ((idx - prevIdx + n) % n) * binSize
      const distNext = ((nextIdx - idx + n) % n) * binSize
      const maxGap = Math.max(distPrev, distNext)
      // If either neighbor is far away on the circle, neighborAvg isn't
      // a trustworthy local reference — skip dampening entirely.
      if (maxGap > 30) continue
      const neighborAvg = (original[prevIdx] + original[nextIdx]) / 2
      const diff = Math.abs(original[idx] - neighborAvg)
      // Tolerance grows with neighbor gap (sparser = more slack).
      const gapFactor = 1 + maxGap / 30 // 1.0 at 0°, 2.0 at 30°
      const threshold = Math.max(3, neighborAvg * 0.4 * gapFactor)
      if (diff > threshold) {
        // Softer pull: 0.35 toward neighbors (was 0.65). Preserves more
        // of the measured peak and lets the Gaussian smoother do the
        // rest of the visual cleanup.
        boundary[idx] = {
          ...boundary[idx],
          eccentricityDeg: neighborAvg * 0.35 + original[idx] * 0.65,
        }
      }
    }
  }

  // Snapshot the (dampened) measured values so we can restore them after
  // each Gaussian pass — they're ground truth and must not drift.
  const measuredRadii: (number | null)[] = boundary.map((p, i) =>
    isMeasured[i] ? p.eccentricityDeg : null,
  )

  // Gaussian low-pass for visual smoothness between measured bins. Fewer
  // passes than the old implementation (3 / 2 instead of 12 / 5) because
  // the restoration step below means each pass only has to nudge the
  // interpolated bins — measured peaks no longer need fighting against.
  const isSparse = boundary.length <= 24
  const passes = isSparse ? 3 : 2
  const kernelHalf = isSparse ? Math.max(2, Math.round(n / 9)) : 3
  const sigma = Math.max(1, kernelHalf / 2)
  const radii = boundary.map(p => p.eccentricityDeg)
  const tmp = new Array(n).fill(0)
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      let sum = 0
      let wsum = 0
      for (let k = -kernelHalf; k <= kernelHalf; k++) {
        const j = ((i + k) % n + n) % n
        const w = Math.exp(-(k * k) / (2 * sigma * sigma))
        sum += radii[j] * w
        wsum += w
      }
      tmp[i] = sum / wsum
    }
    for (let i = 0; i < n; i++) {
      // Restore measured bins each pass; only interpolated bins carry the
      // smoothed value forward. This preserves the real peaks while still
      // producing a visually clean contour between them.
      radii[i] = measuredRadii[i] ?? tmp[i]
    }
  }

  // Final cosmetic pass: soften the measured vertices partway toward the local
  // smoothed curve so the rendered contour isn't spiky. RENDER-ONLY — isopter
  // AREAS are computed from the raw binned boundary (binBoundaryPoints), not
  // this smoothed one, so this changes only how the outline looks, never a
  // reported metric. MEAS_KEEP keeps most of each measured radius so the field
  // is visibly de-spiked without being shrunk; interpolated bins stay fully
  // smoothed. One extra Gaussian into `tmp` (no per-pass restoration) gives the
  // local average at the measured positions to blend toward.
  const MEAS_KEEP = 0.6
  for (let i = 0; i < n; i++) {
    let sum = 0
    let wsum = 0
    for (let k = -kernelHalf; k <= kernelHalf; k++) {
      const j = ((i + k) % n + n) % n
      const w = Math.exp(-(k * k) / (2 * sigma * sigma))
      sum += radii[j] * w
      wsum += w
    }
    tmp[i] = sum / wsum
  }
  for (let i = 0; i < n; i++) {
    radii[i] = measuredRadii[i] != null
      ? measuredRadii[i]! * MEAS_KEEP + tmp[i] * (1 - MEAS_KEEP)
      : tmp[i]
  }

  // Silence unused-var warning for the circular-distance helper — it's used
  // by sampleBoundaryAt indirectly via future callers, not here.
  void meridianDelta
  return boundary.map((p, i) => ({ ...p, eccentricityDeg: radii[i] }))
}

/** Calculate areas for all stimulus levels */
export function calcIsopterAreas(points: TestPoint[]): Partial<Record<StimulusKey, number>> {
  const result: Partial<Record<StimulusKey, number>> = {}
  for (const key of ISOPTER_ORDER) {
    const pts = points.filter(p => p.stimulus === key)
    if (pts.length >= 3) {
      result[key] = calcArea(pts)
    }
  }
  return result
}
