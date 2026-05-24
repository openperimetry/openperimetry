// web/src/clinicalClassifications.ts — severity classification of visual
// field loss based on the fraction of the testable area that was detected.
// Shared between the PDF export, the in-app Interpretation panel, and
// any future renderers so that the clinical grading is defined once.
//
// clinical: bands, thresholds and labels ARE the clinical contract of the
// app — changing them moves the boundary between "mild" and "moderate"
// and shifts every user's label. Do not tweak without a clinical review.

import type { CalibrationData } from './types'

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

/**
 * Expected normal III4e area for a screen-bounded test — the denominator
 * used to turn a measured isopter area into a preserved fraction.
 *
 * A screen-based test cannot reach the full clinical 90° field. The
 * correct reference is the area a healthy eye *could* cover on the
 * specific screen the test was run on — the rectangle formed by the
 * screen, measured from the offset fixation, in degree-space.
 *
 * We compute the area of the largest ellipse that fits inside the screen
 * rectangle — (π/4) × (screenWidth × screenHeight) / ppd² — using the
 * calibration recorded at test time. Using the rectangle itself would
 * overstate the normal reference because a biological isopter is a
 * smooth rounded shape that physically cannot fill the screen corners.
 *
 * When calibration is incomplete (legacy call sites, pre-0.3.0 OVFX
 * imports with no stored screen dimensions) we fall back to
 * π × maxEccentricityDeg² — the circular inscribed fallback that
 * matches the old square-screen approximation.
 *
 * This is the shared denominator for BOTH the in-app Interpretation
 * panel and the PDF export — they must agree on the severity band they
 * show, so the expected-normal-area function lives here with the bands.
 */
export function expectedNormalArea(
  maxEccentricityDeg: number,
  calibration?: CalibrationData,
): number {
  if (calibration?.screenWidthPx != null && calibration?.screenHeightPx != null) {
    const widthDeg = calibration.screenWidthPx / calibration.pixelsPerDegree
    const heightDeg = calibration.screenHeightPx / calibration.pixelsPerDegree
    return (Math.PI / 4) * widthDeg * heightDeg
  }
  return Math.PI * maxEccentricityDeg * maxEccentricityDeg
}
