import type { StoredEye } from './types'

/** Canonical anatomical blindspot location in visual-field coordinates.
 *  ~15° eccentricity on the temporal horizontal meridian, 1.5° below
 *  horizontal. The blindspot is roughly 5.5°(h) × 7.5°(v); the point
 *  returned is its center. */
const BLINDSPOT_HORIZONTAL_ECC_DEG = 15
const BLINDSPOT_VERTICAL_OFFSET_DEG = -1.5  // below horizontal

/** Returns the (meridian°, eccentricity°) polar coordinates of the
 *  blindspot center for the specified eye. Temporal direction flips
 *  between eyes: right eye → 0° meridian, left eye → 180°. */
export function blindspotLocation(eye: StoredEye): {
  meridianDeg: number
  eccentricityDeg: number
} {
  // Temporal meridian (pre-vertical-offset)
  const temporalMeridian = eye === 'right' ? 0 : 180
  // Convert (xDeg, yDeg) → polar
  const xDeg =
    BLINDSPOT_HORIZONTAL_ECC_DEG * Math.cos((temporalMeridian * Math.PI) / 180)
  const yDeg = BLINDSPOT_VERTICAL_OFFSET_DEG
  const eccentricityDeg = Math.sqrt(xDeg * xDeg + yDeg * yDeg)
  const meridianDeg = (Math.atan2(yDeg, xDeg) * 180) / Math.PI
  return { meridianDeg, eccentricityDeg }
}
