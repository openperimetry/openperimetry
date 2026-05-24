import type { TestPoint, StimulusKey } from './types'
import { ISOPTER_ORDER } from './types'

/** How close a detection needs to be to the screen edge to count as
 *  "pinned at the boundary." 2° gives a little slack for RT compensation
 *  and boundary-interpolation rounding without swallowing genuine interior
 *  detections. */
const EDGE_SLACK_DEG = 2

export interface TruncatedIsopter {
  stimulus: StimulusKey
  /** Distinct meridians where the outermost detection sat at the screen
   *  edge with no miss beyond it (i.e., the true boundary is further out
   *  than what we could present). */
  truncatedMeridianCount: number
  /** How far the stimulus was actually measured out to in those truncated
   *  meridians — the "at least this far" clinical floor. */
  maxEccentricityReached: number
}

/** Detect per-stimulus kinetic isopters whose boundary couldn't be found
 *  within the calibrated screen's reachable field.
 *
 *  A meridian is considered truncated for a given stimulus when:
 *    - The furthest detection at that meridian is within `EDGE_SLACK_DEG`
 *      of `maxEccentricityDeg`, AND
 *    - There's no miss ("not seen") on that meridian at a greater
 *      eccentricity — if there were, we'd know the boundary is there.
 *
 *  Under those conditions the real isopter is beyond the screen and the
 *  plotted boundary is a lower bound, not a measurement. Results should
 *  be reported with minimum-extent wording (`≥ X°`) rather than an exact
 *  boundary, and renderers should visually distinguish the truncated
 *  portion. */
export function detectTruncatedIsopters(
  points: TestPoint[],
  maxEccentricityDeg: number,
): TruncatedIsopter[] {
  if (!Number.isFinite(maxEccentricityDeg) || maxEccentricityDeg <= 0) return []
  const result: TruncatedIsopter[] = []

  for (const stim of ISOPTER_ORDER) {
    const stimPts = points.filter(p => p.stimulus === stim && !p.catchTrial)
    if (stimPts.length === 0) continue

    // Bucket by quantized meridian so a patient's individual presentation
    // jitter doesn't fracture "the 90° meridian" into many near-neighbours.
    const bin = (m: number) => Math.round(((m % 360) + 360) % 360 / 5) * 5
    const byMeridian = new Map<number, { detected: number[]; missed: number[] }>()
    for (const p of stimPts) {
      const key = bin(p.meridianDeg)
      let entry = byMeridian.get(key)
      if (!entry) {
        entry = { detected: [], missed: [] }
        byMeridian.set(key, entry)
      }
      ;(p.detected ? entry.detected : entry.missed).push(p.eccentricityDeg)
    }

    let truncatedMeridians = 0
    let maxReached = 0
    for (const { detected, missed } of byMeridian.values()) {
      if (detected.length === 0) continue
      const farthestHit = Math.max(...detected)
      // A miss beyond the farthest hit anchors the boundary — that meridian
      // is NOT truncated regardless of where the hit sat.
      const hasMissBeyond = missed.some(e => e > farthestHit)
      if (hasMissBeyond) continue
      if (farthestHit >= maxEccentricityDeg - EDGE_SLACK_DEG) {
        truncatedMeridians += 1
        if (farthestHit > maxReached) maxReached = farthestHit
      }
    }

    if (truncatedMeridians > 0) {
      result.push({
        stimulus: stim,
        truncatedMeridianCount: truncatedMeridians,
        maxEccentricityReached: maxReached,
      })
    }
  }

  return result
}
