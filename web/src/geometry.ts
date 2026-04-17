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
