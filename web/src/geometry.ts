import type { CalibrationData } from './types'

/** Pixels per centimeter on the physical screen, inferred from the
 *  calibrated `pixelsPerDegree` and viewing distance via the fovea
 *  gradient  ppd = D * (π/180) * ppcm  ⇒  ppcm = ppd * 180 / (π * D). */
export function pixelsPerCm(calib: CalibrationData): number {
  return (calib.pixelsPerDegree * 180) / (Math.PI * calib.viewingDistanceCm)
}

/** Convert a visual-angle offset (degrees) to screen pixels.
 *
 *  Default (`sphericityCorrection` unset or `true`): uses the true
 *  flat-screen formula `offset_cm = D * tan(θ)` where D is viewing
 *  distance and θ is the visual angle. Accurate at every eccentricity;
 *  noticeably matters past ~20° where the linear approximation
 *  under-projects peripheral points on a flat monitor.
 *
 *  ⚠ Despite the `sphericityCorrection` flag name, `D·tan(θ)` is the
 *  flat-screen (gnomonic) projection, not a spherical correction — see the
 *  field doc on `CalibrationData.sphericityCorrection` and report caveat C2.
 *
 *  Explicit opt-out (`sphericityCorrection: false`): plain
 *  `deg * pixelsPerDegree`. Retained so tests, imported OVFX files, or
 *  consumers that deliberately want the small-angle approximation
 *  (matching e.g. SPECVIS's single-scalar px/deg) can request it.
 */
export function degToPx(deg: number, calib: CalibrationData): number {
  if (calib.sphericityCorrection === false) {
    return deg * calib.pixelsPerDegree
  }
  const rad = (deg * Math.PI) / 180
  const cmOffset = calib.viewingDistanceCm * Math.tan(rad)
  return cmOffset * pixelsPerCm(calib)
}

/** Convert a pixel offset from fixation back to a visual-angle eccentricity
 *  (degrees) — the exact inverse of {@link degToPx}. Use this instead of a
 *  plain `px / pixelsPerDegree` whenever a px distance must be reported as an
 *  angle: that linear shortcut matches degToPx only near the axis and badly
 *  over-estimates large angles, which in phone-VR (tiny focal-length px/deg,
 *  edge angles of 40°+) inflates edge/eccentricity values relative to where
 *  stimuli are actually drawn. */
export function pxToDeg(px: number, calib: CalibrationData): number {
  if (calib.sphericityCorrection === false) {
    return px / calib.pixelsPerDegree
  }
  const cmOffset = px / pixelsPerCm(calib)
  const rad = Math.atan(cmOffset / calib.viewingDistanceCm)
  return (rad * 180) / Math.PI
}

/** Convert a (meridian°, eccentricity°) polar coordinate to (x, y) pixel
 *  offsets from the fixation point. Screen y-axis is inverted. */
export function polarDegToXY(
  meridianDeg: number,
  eccentricityDeg: number,
  calib: CalibrationData,
): { x: number; y: number } {
  const rad = (meridianDeg * Math.PI) / 180
  const r = degToPx(eccentricityDeg, calib)
  return {
    x: r * Math.cos(rad),
    y: -r * Math.sin(rad),
  }
}

/**
 * Re-express a polar point measured from one fixation origin as polar relative
 * to a different fixation origin. Both origins are px offsets in the same
 * screen-coordinate frame (y grows down; meridian 0° = right, 90° = up).
 *
 * Used by kinetic extended-field passes: a detection is recorded as
 * (meridian, eccentricity) from the SHIFTED fixation the pass parks at, but the
 * isopter and field map are drawn relative to the patient's CENTERED fixation.
 * Merging the shifted-frame value straight in places the point at the wrong
 * radius/direction (inflating the isopter); reprojecting first puts it at its
 * true eccentricity from center. When `from` and `to` are equal this is the
 * identity (the main test passes the centered fixation as both).
 */
export function reprojectPolar(
  meridianDeg: number,
  eccentricityDeg: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  calib: CalibrationData,
): { meridianDeg: number; eccentricityDeg: number } {
  const rad = (meridianDeg * Math.PI) / 180
  const r = degToPx(eccentricityDeg, calib)
  // Stimulus position in the shared screen frame, then offset from `to`.
  const dx = from.x + r * Math.cos(rad) - to.x
  const dy = from.y - r * Math.sin(rad) - to.y
  let m = (Math.atan2(-dy, dx) * 180) / Math.PI
  if (m < 0) m += 360
  return { meridianDeg: m, eccentricityDeg: pxToDeg(Math.hypot(dx, dy), calib) }
}
