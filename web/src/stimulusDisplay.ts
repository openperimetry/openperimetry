import type { StimulusKey } from './types'

/** The color a stimulus is rendered in *during the test presentation*.
 *
 *  Intentionally returns white for every stimulus key. Using achromatic
 *  stimuli avoids (a) color-vision-deficiency bias, (b) cross-stimulus
 *  luminance confounds from V(λ) (a "blue" stimulus at intensity=1 has
 *  ~1/6 the photopic luminance of a "green" one), and (c) mixing chromatic
 *  cone pathways into what is nominally an achromatic perimetry task.
 *
 *  The per-key color in `STIMULI[key].color` is a *results-map* identifier
 *  only — used to distinguish isopters visually in the PDF, VisualFieldMap,
 *  and history/legend views. It is not used during test presentation. */
export function stimulusDisplayColor(_key: StimulusKey): string {
  return '#ffffff'
}
