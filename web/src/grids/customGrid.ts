/**
 * Parameter-driven static-grid generator — a configurable alternative
 * to the three fixed HFA presets (`hfa24_2.ts`, `hfa30_2.ts`,
 * `hfa10_2.ts`). The caller supplies horizontal/vertical spacing plus
 * field extent, and the generator emits a quad-symmetric grid of
 * stimulus locations radiating out from fixation.
 *
 * Points are seeded at (spacingX/2, spacingY/2) — half a step offset
 * from the cardinal meridians — so no stimulus lands exactly on the
 * x- or y-axis. Coordinates are emitted in degrees and are independent
 * of screen geometry; downstream code maps degrees to pixels at render
 * time using the calibration in `sensitivity.ts` / `VisualFieldMap.tsx`.
 *
 * This generator is selected when `staticGridPattern === 'custom'` in
 * Advanced Settings; the three HFA presets remain the defaults.
 */

import type { GridPoint } from './hfa24_2'

export interface CustomGridParams {
  /** Horizontal inter-stimulus spacing (°). Must be > 0. */
  spacingXDeg: number
  /** Vertical inter-stimulus spacing (°). Must be > 0. */
  spacingYDeg: number
  /** Half-width of the tested visual field (°). Points with |x| > this
   *  value are not generated. Must be > 0. */
  extentXDeg: number
  /** Half-height of the tested visual field (°). Must be > 0. */
  extentYDeg: number
}

/** Built-in presets chosen to mirror the speed/density trade-off users
 *  already understand from the Fast/Normal speed toggle.
 *
 *  - `screening` — 48 points at 7.5° × 6° spacing (anisotropic: wider
 *    horizontal step matches how clinical fields are oriented). Matches
 *    the 48-point layout reported in Dzwiniel et al. 2017 (PLoS ONE
 *    12(10):e0186224), used there as the SuperFast reference protocol.
 *    Shortest exam; coarsest density.
 *  - `fast` (~64 pts, 6°/±24°) — comparable to HFA 24-2 (54).
 *  - `normal` (~100 pts, 4°/±20°) — comparable to HFA 30-2 (76). */
export const CUSTOM_GRID_PRESETS = {
  screening: {
    spacingXDeg: 7.5,
    spacingYDeg: 6,
    extentXDeg: 22.5,
    extentYDeg: 24,
  },
  fast: {
    spacingXDeg: 6,
    spacingYDeg: 6,
    extentXDeg: 24,
    extentYDeg: 24,
  },
  normal: {
    spacingXDeg: 4,
    spacingYDeg: 4,
    extentXDeg: 20,
    extentYDeg: 20,
  },
} as const satisfies Record<string, CustomGridParams>

export type CustomGridPresetName = keyof typeof CUSTOM_GRID_PRESETS

/** Cheap validation — throws on non-finite or non-positive values so
 *  malformed settings (from a corrupt localStorage blob or a bad import)
 *  fail loudly instead of producing zero-point grids. */
function assertValid(p: CustomGridParams): void {
  for (const [k, v] of Object.entries(p)) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`Custom grid param ${k} must be a positive finite number (got ${v})`)
    }
  }
}

/**
 * Generate a quad-symmetric grid for the given parameters.
 *
 * Algorithm:
 *   1. For each of the four quadrants, seed at (spacingX/2, spacingY/2)
 *   2. Walk x outward by spacingX until |x| > extentX
 *   3. For each x, walk y outward by spacingY until |y| > extentY
 *   4. Emit a point at the corresponding signed coordinates
 *
 * The resulting grid is:
 *   - quad-symmetric (reflecting across either axis hits another point)
 *   - eye-independent at generation time — the eye sign is applied by
 *     the caller, matching how `getGrid24_2(eye)` works
 *   - deterministic; identical params produce bit-identical output
 *
 * Points are emitted in a consistent order: upper-left, upper-right,
 * lower-right, lower-left; each row (y) fully walked before advancing x.
 */
export function generateCustomGrid(
  params: CustomGridParams,
  eye: 'right' | 'left' = 'right',
): GridPoint[] {
  assertValid(params)
  const { spacingXDeg, spacingYDeg, extentXDeg, extentYDeg } = params
  const sign = eye === 'right' ? 1 : -1
  const points: GridPoint[] = []

  // Signed seeds for each quarter — a Cartesian product of {±x} × {±y},
  // flattened to four passes so emission order is stable across runs.
  const quarters: Array<[number, number]> = [
    [-1, -1], // upper-left  (screen coords; maps to −x, +y in field coords)
    [+1, -1], // upper-right
    [+1, +1], // lower-right
    [-1, +1], // lower-left
  ]

  for (const [sx, sy] of quarters) {
    for (let ax = spacingXDeg / 2; ax <= extentXDeg; ax += spacingXDeg) {
      for (let ay = spacingYDeg / 2; ay <= extentYDeg; ay += spacingYDeg) {
        // Screen y grows downward; visual-field y grows upward
        // (+y = superior). Flip sy when assigning yDeg so the emitted
        // coordinates align with the rest of the app.
        const xDeg = sign * sx * ax
        const yDeg = -sy * ay
        points.push({ xDeg, yDeg, key: `${xDeg.toFixed(2)},${yDeg.toFixed(2)}` })
      }
    }
  }

  return points
}

/** Expected point count for a given parameter set — closed-form, no
 *  generation required. Handy for UI previews ("This will test ~80
 *  points") without paying the full enumeration cost.
 *
 *  Derivation: each quadrant contains `floor((extent - spacing/2) /
 *  spacing) + 1` seats along each axis, so the total is
 *  `4 * (nx * ny)`. */
export function countCustomGridPoints(params: CustomGridParams): number {
  assertValid(params)
  const { spacingXDeg, spacingYDeg, extentXDeg, extentYDeg } = params
  const nx = Math.floor((extentXDeg - spacingXDeg / 2) / spacingXDeg) + 1
  const ny = Math.floor((extentYDeg - spacingYDeg / 2) / spacingYDeg) + 1
  return 4 * Math.max(0, nx) * Math.max(0, ny)
}
