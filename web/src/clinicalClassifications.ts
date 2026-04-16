// web/src/clinicalClassifications.ts — severity classification of visual
// field loss based on the fraction of the testable area that was detected.
// Shared between the PDF export, the in-app Interpretation panel, and
// any future renderers so that the clinical grading is defined once.
//
// clinical: bands, thresholds and labels ARE the clinical contract of the
// app — changing them moves the boundary between "mild" and "moderate"
// and shifts every user's label. Do not tweak without a clinical review.

export type FieldSeverity =
  | 'normal'
  | 'borderline'
  | 'mild'
  | 'moderate'
  | 'severe'
  | 'very-severe'

export interface ClassificationBand {
  /** Upper bound (inclusive) on preserved fraction for this band. A result
   *  with fraction ≤ maxFraction falls into this band; the bands are
   *  iterated from most-severe to least-severe. */
  readonly maxFraction: number
  readonly label: string
  readonly severity: FieldSeverity
}

export const FIELD_CLASSIFICATION_BANDS: readonly ClassificationBand[] = [
  { maxFraction: 0.05, label: 'Very severe constriction', severity: 'very-severe' },
  { maxFraction: 0.20, label: 'Severe constriction', severity: 'severe' },
  { maxFraction: 0.45, label: 'Moderate constriction', severity: 'moderate' },
  { maxFraction: 0.70, label: 'Mild constriction', severity: 'mild' },
  { maxFraction: 0.85, label: 'Borderline / Early changes', severity: 'borderline' },
  { maxFraction: Infinity, label: 'Within normal range', severity: 'normal' },
]

/**
 * Classify a preserved-fraction ratio into a severity band. Renderers use
 * the returned `severity` key to pick a per-context description (PDF
 * wording vs. in-app card copy) and/or a colour theme.
 */
export function classifyFieldLoss(fraction: number): ClassificationBand {
  for (const band of FIELD_CLASSIFICATION_BANDS) {
    if (fraction <= band.maxFraction) return band
  }
  // Unreachable — last band has maxFraction: Infinity.
  return FIELD_CLASSIFICATION_BANDS[FIELD_CLASSIFICATION_BANDS.length - 1]
}
