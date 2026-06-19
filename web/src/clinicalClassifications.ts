// web/src/clinicalClassifications.ts — severity classification of visual
// field loss based on the fraction of the testable area that was detected.
// Shared between the PDF export, the in-app Interpretation panel, and
// any future renderers so that the clinical grading is defined once.
//
// clinical: bands, thresholds and labels ARE the clinical contract of the
// app — changing them moves the boundary between "mild" and "moderate"
// and shifts every user's label. Do not tweak without a clinical review.

import type { CalibrationData, StimulusKey } from './types'
import { ISOPTER_ORDER } from './types'

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

// The severity bands live in FIELD_SCORE_BANDS below — the old single-isopter
// FIELD_CLASSIFICATION_BANDS / classifyFieldLoss path was removed when the
// headline moved to the multi-isopter scoreField.

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

// ── Multi-isopter field score (base stage + 0–100 score) ──────────────────
// This supersedes the single-isopter grade for the headline severity. Each
// measured isopter is scored as a fraction of its OWN screen-capped normal,
// then averaged → one overall fraction → base stage + 0–100 score. Robust when
// one isopter is atypically low (inferior sector defect dragging III4e down, or
// the VR periphery collapsing III4e): the other isopters hold the average up.
// Pattern (ring scotoma, asymmetry) is reported separately as additive
// modifiers — severity and pattern are orthogonal axes.

/**
 * Per-isopter "normal" reference areas (deg², full clinical field), taken from
 * the 'normal' clinical scenario in testFixtures. A healthy eye's bright/large
 * targets reach far (V4e ~66°) while dim/small ones stay central (I2e ~22°), so
 * each isopter needs its OWN denominator — scoring every isopter against one
 * screen-rectangle area would mislabel the inherently-small inner isopters.
 * Kept in sync with the fixture by clinicalClassifications.test.ts.
 */
export const NORMAL_ISOPTER_AREA: Record<StimulusKey, number> = {
  V4e: 13578,
  III4e: 8762,
  III2e: 5315,
  I4e: 3149,
  I2e: 1514,
}

/**
 * Severity bands for the multi-isopter preserved-fraction metric (scoreField).
 * Anchored to the RP stage scenarios so each self-classifies to its stage
 * (Normal→normal … Very Severe→very-severe) under both the uncapped reference
 * and a realistic screen calibration. clinical: a contract; change with review.
 */
export const FIELD_SCORE_BANDS: readonly ClassificationBand[] = [
  { maxFraction: 0.0128, label: 'Very severe constriction', severity: 'very-severe' },
  { maxFraction: 0.045, label: 'Severe constriction', severity: 'severe' },
  { maxFraction: 0.156, label: 'Moderate constriction', severity: 'moderate' },
  { maxFraction: 0.40, label: 'Mild constriction', severity: 'mild' },
  { maxFraction: 0.65, label: 'Borderline / Early changes', severity: 'borderline' },
  { maxFraction: Infinity, label: 'Within normal range', severity: 'normal' },
]

export function classifyFieldScore(fraction: number): ClassificationBand {
  for (const band of FIELD_SCORE_BANDS) {
    if (fraction <= band.maxFraction) return band
  }
  return FIELD_SCORE_BANDS[FIELD_SCORE_BANDS.length - 1]
}

/** Preserved fraction mapped to score 0; normal (1.0) maps to 100. */
const SCORE_FLOOR_FRACTION = 0.005
const LN_FLOOR = Math.log(SCORE_FLOOR_FRACTION)

/**
 * Map a preserved fraction to a 0–100 field-preservation score. Log-scaled so
 * each halving of the preserved field is a constant drop (≈15 pts) — keeps the
 * score perceptually even across stages and meaningful to track over time.
 * 100 = normal; 0 = at/below the floor.
 */
export function fractionToScore(fraction: number): number {
  if (!(fraction > 0)) return 0
  const s = (100 * (Math.log(fraction) - LN_FLOOR)) / (0 - LN_FLOOR)
  return Math.max(0, Math.min(100, Math.round(s)))
}

export interface IsopterScore {
  key: StimulusKey
  /** Preserved fraction vs this isopter's screen-capped normal. */
  fraction: number
  band: ClassificationBand
}

export interface FieldScore {
  /** Per-isopter fraction + band (in ISOPTER_ORDER) for the measured isopters. */
  perIsopter: IsopterScore[]
  /** Mean of the per-isopter fractions — the overall preserved fraction. */
  overallFraction: number
  /** Overall severity band — the base stage. */
  band: ClassificationBand
  /** 0–100 field-preservation score (100 = normal). */
  score: number
}

/**
 * Multi-isopter field score. Returns null when no isopter was measured.
 *
 * Each isopter's denominator is min(screen-testable area, that isopter's normal)
 * so (a) the inherently-small inner isopters are scored against their own
 * normal, and (b) a small VR screen — which physically can't reach the
 * periphery — doesn't masquerade as constriction.
 */
export function scoreField(
  isopterAreas: Partial<Record<StimulusKey, number>>,
  maxEccentricityDeg: number,
  calibration?: CalibrationData,
): FieldScore | null {
  const testable = expectedNormalArea(maxEccentricityDeg, calibration)
  const perIsopter: IsopterScore[] = []
  for (const key of ISOPTER_ORDER) {
    const area = isopterAreas[key]
    if (area == null) continue
    const expected = Math.min(testable, NORMAL_ISOPTER_AREA[key])
    const fraction = expected > 0 ? area / expected : 0
    perIsopter.push({ key, fraction, band: classifyFieldScore(fraction) })
  }
  if (perIsopter.length === 0) return null
  const overallFraction =
    perIsopter.reduce((s, p) => s + p.fraction, 0) / perIsopter.length
  return {
    perIsopter,
    overallFraction,
    band: classifyFieldScore(overallFraction),
    score: fractionToScore(overallFraction),
  }
}
