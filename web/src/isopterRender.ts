/**
 * Shared isopter rendering helpers used by both the in-app VisualFieldMap
 * and the PDF export so the two renderers produce identical contours.
 *
 * Boundary binning + gap-interpolation + peak-preserving smoothing lives
 * in ./isopterCalc (`computeSmoothedBoundary`). This module turns the
 * resulting per-level meridian/eccentricity polyline into pixel-space
 * points and a Catmull-Rom closed path suitable for SVG output.
 */

import type { TestPoint, StimulusKey } from './types'
import { ISOPTER_ORDER } from './types'
import { computeSmoothedBoundary, clampBoundary } from './isopterCalc'

/** Polar (eccentricity°, meridian°) → cartesian pixel in radar-image space.
 *  Matches the convention used by VisualFieldMap and the PDF radar image:
 *  meridian 0° points right, positive meridian rotates counter-clockwise
 *  (so we subtract the sin term from y because SVG's y grows downward). */
export function polarToXY(
  eccDeg: number,
  meridianDeg: number,
  center: number,
  scale: number,
): [number, number] {
  const r = eccDeg * scale
  const theta = (meridianDeg * Math.PI) / 180
  return [center + r * Math.cos(theta), center - r * Math.sin(theta)]
}

/** Catmull-Rom smooth closed path through a cyclic list of pixel points. */
export function smoothClosedPath(pts: [number, number][]): string {
  const n = pts.length
  if (n < 3) return ''

  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]

    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`
  }
  return d + ' Z'
}

export interface SmoothedIsopter {
  key: StimulusKey
  isopterIdx: number
  svgPts: [number, number][]
  isScattered: boolean
}

/** Pre-compute smoothed isopter boundaries in pixel space, with each
 *  dimmer isopter clamped to nest inside the next brighter one. Both
 *  VisualFieldMap (on-screen) and pdfExport (for the PDF radar image)
 *  call this so their contours are pixel-identical. */
export function computeIsopters(
  grouped: Partial<Record<StimulusKey, TestPoint[]>>,
  center: number,
  scale: number,
): SmoothedIsopter[] {
  const results: SmoothedIsopter[] = []
  let prevBoundary: { meridianDeg: number; eccentricityDeg: number }[] | null = null

  for (let isopterIdx = 0; isopterIdx < ISOPTER_ORDER.length; isopterIdx++) {
    const key = ISOPTER_ORDER[isopterIdx]
    const pts = grouped[key]
    if (!pts) continue

    const allDetected = pts.filter(p => p.detected)
    let smoothed = computeSmoothedBoundary(allDetected)
    if (smoothed.length < 3) continue
    const isScattered = allDetected.length > 20

    // Clamp to not exceed the brighter level's boundary. Uses meridian-aware
    // sampling (not index equality) so mismatched bin counts between levels
    // don't silently skip the clamp.
    if (prevBoundary) {
      smoothed = clampBoundary(smoothed, prevBoundary)
    }
    prevBoundary = smoothed

    const svgPts = smoothed.map(
      p => polarToXY(p.eccentricityDeg, p.meridianDeg, center, scale) as [number, number],
    )

    results.push({ key, isopterIdx, svgPts, isScattered })
  }

  return results
}
