/**
 * Humphrey Field Analyzer 10-2 test pattern.
 *
 * 68 locations on a 2° grid extending to ±9° horizontal and ±9°
 * vertical. Used clinically when only central vision remains — late-
 * stage RP, macular disease, advanced glaucoma — because the 6° spacing
 * of 24-2/30-2 is too coarse to meaningfully characterise the remaining
 * island.
 */
import type { GridPoint } from './hfa24_2'

const HFA_10_2_OD: Array<[number, number]> = [
  // y = +9
  [-3, 9], [-1, 9], [1, 9], [3, 9],
  // y = +7
  [-5, 7], [-3, 7], [-1, 7], [1, 7], [3, 7], [5, 7],
  // y = +5
  [-7, 5], [-5, 5], [-3, 5], [-1, 5], [1, 5], [3, 5], [5, 5], [7, 5],
  // y = +3
  [-7, 3], [-5, 3], [-3, 3], [-1, 3], [1, 3], [3, 3], [5, 3], [7, 3],
  // y = +1
  [-7, 1], [-5, 1], [-3, 1], [-1, 1], [1, 1], [3, 1], [5, 1], [7, 1],
  // y = -1
  [-7, -1], [-5, -1], [-3, -1], [-1, -1], [1, -1], [3, -1], [5, -1], [7, -1],
  // y = -3
  [-7, -3], [-5, -3], [-3, -3], [-1, -3], [1, -3], [3, -3], [5, -3], [7, -3],
  // y = -5
  [-7, -5], [-5, -5], [-3, -5], [-1, -5], [1, -5], [3, -5], [5, -5], [7, -5],
  // y = -7
  [-5, -7], [-3, -7], [-1, -7], [1, -7], [3, -7], [5, -7],
  // y = -9
  [-3, -9], [-1, -9], [1, -9], [3, -9],
]

export function getGrid10_2(eye: 'right' | 'left'): GridPoint[] {
  const sign = eye === 'right' ? 1 : -1
  return HFA_10_2_OD.map(([x, y]) => {
    const xDeg = sign * x
    const yDeg = y
    return { xDeg, yDeg, key: `${xDeg.toFixed(2)},${yDeg.toFixed(2)}` }
  })
}
