/**
 * Shared isopter rendering helpers used by both the in-app VisualFieldMap
 * and the PDF export so the two renderers produce identical contours.
 *
 * Boundary binning + gap-interpolation + peak-preserving smoothing lives
 * in ./isopterCalc (`computeSmoothedBoundary`). This module turns the
 * resulting per-level meridian/eccentricity polyline into pixel-space
 * points and a Catmull-Rom closed path suitable for SVG output.
 */

import type { TestPoint, StimulusKey, CalibrationData } from './types'
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

/**
 * Plotted radar extent in degrees for a result. Phone-VR fits the rings/scale
 * to the measured data (a small buffer past the outermost point) so a ~32°
 * field isn't drawn as a tiny isopter inside the ~44° screen-edge halo that
 * `maxEccentricityDeg` represents in VR. Returns `undefined` for non-VR (and
 * when there's no usable data) so callers pass nothing and the radar renders
 * exactly as before. Render-only — never feeds areas or classification.
 */
export function vrPlotExtentDeg(
  points: TestPoint[],
  calibration: CalibrationData | undefined,
  maxEccentricityDeg: number,
): number | undefined {
  if (!calibration?.vr?.enabled) return undefined
  let dataMax = 0
  for (const p of points) if (p.eccentricityDeg > dataMax) dataMax = p.eccentricityDeg
  if (dataMax <= 0) return undefined
  // Cap at the true testable extent so a genuinely wide field is never clipped.
  return Math.min(maxEccentricityDeg, dataMax * 1.15)
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

export interface ScreenBoundary {
  /** Screen-reachable polygon in radar-image pixel space (72 samples). */
  points: [number, number][]
  /** `"x1,y1 x2,y2 ..."` for `<polygon points=...>`. */
  polygonStr: string
  /** SVG path `M x y L x y ... Z`. */
  polygonPath: string
  /** Evenodd-fill path combining the chart outer circle and the screen
   *  polygon, so a single `<path>` fills the annulus between them — the
   *  "not tested beyond screen" mask. */
  maskPath: string
}

/** Project the calibrated screen's reachable field onto radar-image pixel
 *  space. VisualFieldMap and pdfExport.renderRadarImage both consume this
 *  so the untested-area overlay stays pixel-identical across surfaces.
 *
 *  Returns `null` when screen dimensions aren't recorded on the
 *  calibration (legacy pre-screenWidthPx results) and no fallback is
 *  supplied — callers should skip the overlay in that case rather than
 *  guessing. */
export function computeScreenBoundary(
  calibration: CalibrationData,
  center: number,
  scale: number,
  radius: number,
  fallback?: { width: number; height: number },
): ScreenBoundary | null {
  const screenW = calibration.screenWidthPx ?? fallback?.width
  const screenH = calibration.screenHeightPx ?? fallback?.height
  if (screenW == null || screenH == null) return null

  const pxPerDeg = calibration.pixelsPerDegree
  const fx = calibration.fixationOffsetPx
  const halfW = screenW / 2
  const halfH = screenH / 2
  const outerR = radius + 5
  const points = Array.from({ length: 72 }, (_, i) => {
    const angleDeg = i * 5
    const rad = (angleDeg * Math.PI) / 180
    const cos = Math.cos(rad)
    // SVG y grows downward; flip sin so meridian 90° lands at the top.
    const sin = -Math.sin(rad)
    let t = Number.POSITIVE_INFINITY
    if (cos > 0.001) t = Math.min(t, (halfW - fx) / cos)
    if (cos < -0.001) t = Math.min(t, (-halfW - fx) / cos)
    if (sin > 0.001) t = Math.min(t, halfH / sin)
    if (sin < -0.001) t = Math.min(t, (-halfH) / sin)
    const eccDeg = t / pxPerDeg
    const r = Math.min(eccDeg * scale, outerR)
    return [center + r * Math.cos(rad), center + r * sin] as [number, number]
  })

  const polygonStr = points.map(([x, y]) => `${x},${y}`).join(' ')
  const polygonPath = 'M ' + points.map(([x, y]) => `${x} ${y}`).join(' L ') + ' Z'
  const circlePath =
    `M ${center + outerR} ${center} ` +
    `A ${outerR} ${outerR} 0 1 0 ${center - outerR} ${center} ` +
    `A ${outerR} ${outerR} 0 1 0 ${center + outerR} ${center} Z`
  const maskPath = `${circlePath} ${polygonPath}`

  return { points, polygonStr, polygonPath, maskPath }
}
