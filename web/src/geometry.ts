import type { CalibrationData } from './types'

/** Pixels per centimeter on the physical screen, inferred from the
 *  calibrated `pixelsPerDegree` and viewing distance via the fovea
 *  gradient  ppd = D * (π/180) * ppcm  ⇒  ppcm = ppd * 180 / (π * D). */
export function pixelsPerCm(calib: CalibrationData): number {
  return (calib.pixelsPerDegree * 180) / (Math.PI * calib.viewingDistanceCm)
}

/** Convert a visual-angle offset (degrees) to screen pixels.
 *
 *  Default (linear): `deg * pixelsPerDegree`. Good to ~1% within 5° of
 *  fixation; under-projects peripheral eccentricities on a flat screen.
 *
 *  With `calib.sphericityCorrection=true`: uses `D * tan(θ)` where D is
 *  viewing distance and θ is the visual angle, producing the true flat-
 *  screen pixel offset. Matters for extended-field (>~30°) testing.
 */
export function degToPx(deg: number, calib: CalibrationData): number {
  if (!calib.sphericityCorrection) {
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
