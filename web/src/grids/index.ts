/**
 * Unified entry point for static-perimetry test grids.
 *
 * Four supported patterns:
 *   - `24-2`, `30-2`, `10-2` — fixed HFA presets (the de-facto clinical
 *     standards). Point coordinates are hardcoded from the Humphrey
 *     Field Analyzer spec.
 *   - `custom` — a parameter-driven generator. Spacing and extent come
 *     from AdvancedSettings so users can tune density and coverage;
 *     see `./customGrid.ts` and the Advanced Settings panel.
 *
 * 24-2 is the default because it's the most commonly-administered
 * clinical grid; 30-2 is the RP-literature favourite; 10-2 is reserved
 * for advanced cases where only central field remains; `custom` is
 * opt-in for users who want clinician-level control over the grid.
 */
export type { GridPoint } from './hfa24_2'
export { getGrid24_2 } from './hfa24_2'
export { getGrid30_2 } from './hfa30_2'
export { getGrid10_2 } from './hfa10_2'
export {
  generateCustomGrid,
  countCustomGridPoints,
  CUSTOM_GRID_PRESETS,
  type CustomGridParams,
  type CustomGridPresetName,
} from './customGrid'

import type { GridPoint } from './hfa24_2'
import { getGrid24_2 } from './hfa24_2'
import { getGrid30_2 } from './hfa30_2'
import { getGrid10_2 } from './hfa10_2'
import {
  generateCustomGrid,
  countCustomGridPoints,
  CUSTOM_GRID_PRESETS,
  type CustomGridParams,
} from './customGrid'

export type StaticGridPattern = '24-2' | '30-2' | '10-2' | 'custom'

/** Human-facing label + approximate point count for each pattern. For
 *  `custom` the point count is dynamic — we report the count under
 *  the default ("normal") params so UI copy ("~100 points") has a
 *  sensible default; actual runs use the live params from
 *  AdvancedSettings. */
export const STATIC_GRID_INFO: Record<StaticGridPattern, { label: string; points: number; description: string }> = {
  '24-2': { label: '24-2', points: 54, description: 'Standard clinical screening. Central ±24°.' },
  '30-2': { label: '30-2', points: 76, description: 'Wider vertical coverage (±27°). Preferred for RP monitoring.' },
  '10-2': { label: '10-2', points: 68, description: 'Central ±9° at 2° spacing. For advanced RP / macular disease.' },
  'custom': {
    label: 'Custom',
    points: countCustomGridPoints(CUSTOM_GRID_PRESETS.normal),
    description: 'Parameter-driven grid. Spacing and extent configurable in Advanced Settings.',
  },
}

/** Resolve a static grid to concrete points.
 *
 *  `customParams` is required when `pattern === 'custom'` and ignored
 *  otherwise. We make it a separate argument rather than optional-with-
 *  fallback so a caller that forgets to thread params through gets a
 *  compile-time error instead of silently running the default preset. */
export function getStaticGrid(
  pattern: StaticGridPattern,
  eye: 'right' | 'left',
  customParams?: CustomGridParams,
): GridPoint[] {
  switch (pattern) {
    case '24-2': return getGrid24_2(eye)
    case '30-2': return getGrid30_2(eye)
    case '10-2': return getGrid10_2(eye)
    case 'custom': {
      if (!customParams) {
        throw new Error('getStaticGrid("custom") requires customParams')
      }
      return generateCustomGrid(customParams, eye)
    }
  }
}
