/**
 * Humphrey Field Analyzer 30-2 test pattern.
 *
 * 76 locations on a 6° grid extending to ±27° horizontal and ±27°
 * vertical. Preferred in RP monitoring literature because the extra
 * vertical coverage (±27° vs 24-2's ±21°) catches more of the
 * mid-peripheral ring loss that's characteristic of RP.
 */
import type { GridPoint } from './hfa24_2'

const HFA_30_2_OD: Array<[number, number]> = [
  // y = +27
  [-9, 27], [-3, 27], [3, 27], [9, 27],
  // y = +21
  [-15, 21], [-9, 21], [-3, 21], [3, 21], [9, 21], [15, 21],
  // y = +15
  [-21, 15], [-15, 15], [-9, 15], [-3, 15], [3, 15], [9, 15], [15, 15], [21, 15],
  // y = +9
  [-27, 9], [-21, 9], [-15, 9], [-9, 9], [-3, 9], [3, 9], [9, 9], [15, 9], [21, 9], [27, 9],
  // y = +3
  [-27, 3], [-21, 3], [-15, 3], [-9, 3], [-3, 3], [3, 3], [9, 3], [15, 3], [21, 3], [27, 3],
  // y = -3
  [-27, -3], [-21, -3], [-15, -3], [-9, -3], [-3, -3], [3, -3], [9, -3], [15, -3], [21, -3], [27, -3],
  // y = -9
  [-27, -9], [-21, -9], [-15, -9], [-9, -9], [-3, -9], [3, -9], [9, -9], [15, -9], [21, -9], [27, -9],
  // y = -15
  [-21, -15], [-15, -15], [-9, -15], [-3, -15], [3, -15], [9, -15], [15, -15], [21, -15],
  // y = -21
  [-15, -21], [-9, -21], [-3, -21], [3, -21], [9, -21], [15, -21],
  // y = -27
  [-9, -27], [-3, -27], [3, -27], [9, -27],
]

export function getGrid30_2(eye: 'right' | 'left'): GridPoint[] {
  const sign = eye === 'right' ? 1 : -1
  return HFA_30_2_OD.map(([x, y]) => {
    const xDeg = sign * x
    const yDeg = y
    return { xDeg, yDeg, key: `${xDeg.toFixed(2)},${yDeg.toFixed(2)}` }
  })
}
