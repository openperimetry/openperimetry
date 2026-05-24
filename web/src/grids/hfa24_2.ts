/**
 * Humphrey Field Analyzer 24-2 test pattern.
 *
 * 54 locations on a 6° grid extending to ±27° horizontal and ±21° vertical
 * (coarser +27° steps only on the horizontal meridian rows). The de-facto
 * global standard for static perimetry screening — every clinical HFA runs
 * this pattern. We use it so results are conceptually comparable to any
 * clinic printout the user may already have.
 *
 * Coordinates are in degrees of visual angle from fixation, right-eye
 * convention (positive x = temporal / nasal depending on eye — see
 * `getGrid24_2` below which mirrors for the left eye).
 *
 * The blind-spot row (y = ±3, x near +15 for right eye) is INCLUDED — on
 * a real HFA those points serve as a fixation-stability check (a healthy
 * patient should miss them, an inattentive one will "see" them). We
 * don't yet use them that way, but leaving them in keeps the pattern
 * recognisable to any clinician looking at the map.
 */

export interface GridPoint {
  xDeg: number
  yDeg: number
  key: string
}

/** Right-eye 24-2 coordinates. Rows top-to-bottom, columns left-to-right. */
const HFA_24_2_OD: Array<[number, number]> = [
  // y = +21
  [-9, 21], [-3, 21], [3, 21], [9, 21],
  // y = +15
  [-15, 15], [-9, 15], [-3, 15], [3, 15], [9, 15], [15, 15],
  // y = +9
  [-21, 9], [-15, 9], [-9, 9], [-3, 9], [3, 9], [9, 9], [15, 9], [21, 9],
  // y = +3
  [-27, 3], [-21, 3], [-15, 3], [-9, 3], [-3, 3], [3, 3], [9, 3], [15, 3], [21, 3],
  // y = -3
  [-27, -3], [-21, -3], [-15, -3], [-9, -3], [-3, -3], [3, -3], [9, -3], [15, -3], [21, -3],
  // y = -9
  [-21, -9], [-15, -9], [-9, -9], [-3, -9], [3, -9], [9, -9], [15, -9], [21, -9],
  // y = -15
  [-15, -15], [-9, -15], [-3, -15], [3, -15], [9, -15], [15, -15],
  // y = -21
  [-9, -21], [-3, -21], [3, -21], [9, -21],
]

/**
 * Get the 24-2 grid points for the given eye.
 *
 * For the left eye we mirror x → -x so the pattern is topologically
 * identical but reflects the correct retinal geometry (the blind spot
 * lands on the opposite side of fixation).
 */
export function getGrid24_2(eye: 'right' | 'left'): GridPoint[] {
  const sign = eye === 'right' ? 1 : -1
  return HFA_24_2_OD.map(([x, y]) => {
    const xDeg = sign * x
    const yDeg = y
    return { xDeg, yDeg, key: `${xDeg.toFixed(2)},${yDeg.toFixed(2)}` }
  })
}
