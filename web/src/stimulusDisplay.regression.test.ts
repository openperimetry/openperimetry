import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Regression guard for Phase 3 (achromatic stimulus presentation).
 *
 * Every test component that renders a stimulus during presentation MUST route
 * its color through `stimulusDisplayColor()`. This test reads each file as
 * text and asserts the import is present, protecting against a future edit
 * that bypasses the helper and reintroduces chromatic stimuli (which would
 * re-introduce color-vision-deficiency bias and V(λ) luminance confounds).
 *
 * If you need to add another test-presentation component, add it to the list.
 */
const COMPONENTS_THAT_PRESENT_STIMULI = [
  'components/StaticTest.tsx',
  'components/GoldmannTest.tsx',
  'components/RingTest.tsx',
]

describe('stimulus presentation uses stimulusDisplayColor helper', () => {
  for (const relPath of COMPONENTS_THAT_PRESENT_STIMULI) {
    it(`${relPath} imports and calls stimulusDisplayColor`, () => {
      const full = resolve(__dirname, relPath)
      const source = readFileSync(full, 'utf8')
      expect(source, `${relPath} must import stimulusDisplayColor from ../stimulusDisplay`).toMatch(
        /import\s+\{[^}]*\bstimulusDisplayColor\b[^}]*\}\s+from\s+['"]\.\.\/stimulusDisplay['"]/,
      )
      expect(source, `${relPath} must actually call stimulusDisplayColor(...)`).toMatch(
        /\bstimulusDisplayColor\s*\(/,
      )
    })
  }
})
