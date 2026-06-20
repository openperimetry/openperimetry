// web/src/fieldAnalysis.ts — pure analysis of a visual-field result.
// Shared between the in-app Interpretation panel and the PDF export so
// both renderers agree on which findings are present, the thresholds
// used to flag them, and the prose shown to the user.
//
// Clinical contract: the thresholds and labels in this file decide
// whether a result is classed as e.g. "Steep sensitivity drop-off" or
// "Ring scotoma — moderate". Changing them moves the boundary between
// two verdicts for every user of the app. Do not tweak without a
// clinical review.
//
// The module emits **tone keys** instead of Tailwind classes or jsPDF
// RGB triples so the two renderers can map the same finding to their
// own theming. Tones:
//   - critical  : red    — severe/dire finding
//   - warning   : orange — significant abnormality
//   - caution   : yellow — mild abnormality / watch-this
//   - info      : blue   — notable but not pathological
//   - ok        : green  — reassuring / within normal
//   - muted     : gray   — finding absent / not flagged
//
// Anomalies (data-quality / artifact flags) use the same `tone` palette
// so each renderer only needs one tone→colour table. The separate
// `icon` field encodes the 3-band ℹ/⚠/✕ prefix the two renderers both
// show for that section.

import type { TestPoint, StimulusKey, CalibrationData } from './types'
import { STIMULI, ISOPTER_ORDER } from './types'
import { scoreField, type FieldScore } from './clinicalClassifications'

export type Tone = 'critical' | 'warning' | 'caution' | 'info' | 'ok' | 'muted'

export type AnomalyIcon = 'info' | 'warning' | 'error'

export interface Finding {
  tone: Tone
  label: string
  description: string
}

export interface PatternModifier extends Finding {
  /** Stable key so React renderers can supply `key=` without index hacks. */
  key: string
}

export interface RPFinding extends Finding {
  /** Whether the indicator is actually flagged for this result. Callers
   *  decide whether to surface not-present findings (the in-app panel
   *  filters to only `present`; a verbose renderer could show all). */
  present: boolean
}

export interface Anomaly extends Finding {
  /** Which of the three anomaly icons (ℹ / ⚠ / ✕) to show. Separate
   *  from `tone` so the colour and the icon can be picked independently
   *  by each renderer. */
  icon: AnomalyIcon
}

// ── Sensitivity gradient (III2e / III4e) ─────────────────────────────

export function analyzeSensitivityGradient(
  areas: Partial<Record<StimulusKey, number>>,
): Finding | null {
  const iii4e = areas['III4e']
  const iii2e = areas['III2e']
  if (iii4e == null || iii2e == null || iii4e === 0) return null

  // On severely constricted fields (III4e < 500 deg²) the ratio reflects
  // proportional constriction rather than a true differential sensitivity
  // loss — both isopters are tiny. Skip the gradient analysis so we don't
  // confuse the user with a "steep drop-off" verdict that is really just
  // "everything is tiny".
  if (iii4e < 500) return null

  const ratio = iii2e / iii4e
  if (ratio < 0.05) {
    return {
      tone: 'warning',
      label: 'Steep sensitivity drop-off',
      description:
        'The dim stimulus (III2e) is barely seen compared to the bright one (III4e). This suggests a sharp boundary between functioning and non-functioning retina — typical of RP scotomas.',
    }
  }
  if (ratio < 0.20) {
    return {
      tone: 'caution',
      label: 'Significant sensitivity gradient',
      description:
        'There is a large difference between bright (III4e) and dim (III2e) stimulus detection. The retina in the mid-periphery has reduced sensitivity even where it still detects bright stimuli.',
    }
  }
  if (ratio < 0.50) {
    return {
      tone: 'info',
      label: 'Moderate sensitivity gradient',
      description:
        'The sensitivity gradient between bright and dim stimuli is moderate. Some retinal sensitivity loss is present in areas that still detect larger or brighter targets.',
    }
  }
  return {
    tone: 'ok',
    label: 'Preserved sensitivity',
    description:
      'Dim stimuli are detected across a reasonable portion of the field. Retinal sensitivity is relatively well-preserved where the field is intact.',
  }
}

// ── Central island (I2e) ─────────────────────────────────────────────

export function analyzeCentralIsland(
  areas: Partial<Record<StimulusKey, number>>,
): Finding | null {
  const i2e = areas['I2e']
  if (i2e == null) return null

  if (i2e < 10) {
    return {
      tone: 'critical',
      label: 'Very small central island',
      description:
        'Fine detail vision (I2e) is limited to less than ~2° radius. Reading and tasks requiring fine acuity may be significantly affected.',
    }
  }
  if (i2e < 50) {
    return {
      tone: 'warning',
      label: 'Small central island',
      description:
        'Fine detail vision (I2e) is present but limited to a small central area (~2–4° radius). Central acuity may still be functional for reading with appropriate aids.',
    }
  }
  if (i2e < 200) {
    return {
      tone: 'caution',
      label: 'Moderate central field',
      description:
        'Fine detail vision (I2e) covers a moderate central area. Central function is relatively well preserved.',
    }
  }
  return {
    tone: 'ok',
    label: 'Good central field',
    description:
      'Fine detail vision (I2e) is present across a healthy central area. Central retinal function appears well preserved.',
  }
}

// ── Pattern modifiers ────────────────────────────────────────────────
// Additive overlays on the headline severity tier: ring scotoma and
// vertical asymmetry. These can coexist with any `classifyField` tier,
// so they are returned alongside it rather than replacing it.

function detectRingScotomaPattern(
  areas: Partial<Record<StimulusKey, number>>,
): PatternModifier | null {
  const ordered = ISOPTER_ORDER
    .map(key => ({ key, area: areas[key] }))
    .filter((o): o is { key: StimulusKey; area: number } => o.area != null)

  if (ordered.length < 3) return null

  // Count disproportionate drops between consecutive isopter areas. A drop
  // > 60% where the outer area is large indicates a scotoma band.
  let innerArea: number | null = null
  let dropCount = 0
  for (let i = 0; i < ordered.length - 1; i++) {
    const dropRatio = 1 - ordered[i + 1].area / ordered[i].area
    if (dropRatio > 0.60 && ordered[i].area > 1500) {
      if (innerArea == null) innerArea = ordered[i + 1].area
      dropCount++
    }
  }
  if (innerArea == null) return null

  const innerRadius = Math.sqrt(innerArea / Math.PI)
  const isMulti = dropCount > 1
  const multiSuffix = isMulti ? ' (double-ring)' : ''
  const multiText = isMulti ? ' with multiple scotoma bands' : ''

  if (innerArea <= 100) {
    return {
      key: 'ring-scotoma',
      tone: 'critical',
      label: `Ring scotoma — severe${multiSuffix}`,
      description: `A ring-shaped scotoma is present${multiText}. Continuous central vision extends only ~${innerRadius.toFixed(0)}° before a mid-peripheral blind band. The far periphery may still be preserved, but the functional field is severely limited.`,
    }
  }
  if (innerArea <= 800) {
    return {
      key: 'ring-scotoma',
      tone: 'warning',
      label: `Ring scotoma — moderate${multiSuffix}`,
      description: `A ring-shaped scotoma is present${multiText} in the mid-periphery. Central vision is preserved to ~${innerRadius.toFixed(0)}° with peripheral vision beyond the scotoma band. This is a characteristic mid-stage RP pattern.`,
    }
  }
  return {
    key: 'ring-scotoma',
    tone: 'caution',
    label: `Ring scotoma — mild${multiSuffix}`,
    description: `A mild ring scotoma pattern is detected${multiText}. Central vision is relatively well preserved (~${innerRadius.toFixed(0)}° radius) but there is a band of reduced sensitivity in the mid-periphery.`,
  }
}

function detectAsymmetryPattern(points: TestPoint[]): PatternModifier | null {
  const iii4eDetected = points.filter(p => p.stimulus === 'III4e' && p.detected)
  if (iii4eDetected.length < 8) return null
  const superior = iii4eDetected.filter(p => p.meridianDeg >= 30 && p.meridianDeg <= 150)
  const inferior = iii4eDetected.filter(p => p.meridianDeg >= 210 && p.meridianDeg <= 330)
  if (superior.length < 2 || inferior.length < 2) return null
  const supMean = superior.reduce((s, p) => s + p.eccentricityDeg, 0) / superior.length
  const infMean = inferior.reduce((s, p) => s + p.eccentricityDeg, 0) / inferior.length
  const ratio = Math.min(supMean, infMean) / Math.max(supMean, infMean)
  if (ratio >= 0.65) return null
  const moreAffected = supMean < infMean ? 'superior' : 'inferior'
  const moreVal = moreAffected === 'superior' ? supMean : infMean
  const lessVal = moreAffected === 'superior' ? infMean : supMean
  return {
    key: 'asymmetry',
    tone: 'caution',
    label: 'Vertical field asymmetry',
    description: `The ${moreAffected} visual field is more constricted (${moreVal.toFixed(0)}° vs ${lessVal.toFixed(0)}°). ${moreAffected === 'inferior' ? 'Inferior field loss preceding superior is a common early pattern in RP.' : 'Superior field loss can occur in RP and other retinal conditions.'}`,
  }
}

export function detectFieldPatterns(
  points: TestPoint[],
  areas: Partial<Record<StimulusKey, number>>,
): PatternModifier[] {
  const patterns: PatternModifier[] = []
  const ring = detectRingScotomaPattern(areas)
  if (ring) patterns.push(ring)
  const asym = detectAsymmetryPattern(points)
  if (asym) patterns.push(asym)
  return patterns
}

// ── RP-specific findings ─────────────────────────────────────────────
// Six retinitis-pigmentosa-flavoured indicators. Each finding has a
// `present` flag so renderers can choose whether to show only flagged
// findings (the in-app panel does this) or also include "not detected"
// reassurance cards.

export function detectRPFindings(
  points: TestPoint[],
  areas: Partial<Record<StimulusKey, number>>,
  maxEccentricityDeg: number,
  calibration?: CalibrationData,
  /** The headline field score. Pass the already-computed result so the
   *  concentric-constriction card and the headline stage share ONE source of
   *  truth and can't contradict each other. Omit (undefined) to compute it
   *  here; pass null only to force "no measurable field". */
  fieldScore?: FieldScore | null,
): RPFinding[] {
  const findings: RPFinding[] = []

  const v4e = areas['V4e']
  const iii4e = areas['III4e']
  const iii2e = areas['III2e']
  const i4e = areas['I4e']
  const i2e = areas['I2e']

  // 1. Concentric constriction — hallmark of RP. Driven by the SAME
  //    multi-isopter field score as the headline stage, so this card can never
  //    contradict it (a single-isopter test here used to flag "tunnel vision"
  //    while the averaged headline read normal, and vice-versa). Callers pass
  //    the headline's already-computed score in; undefined means compute it.
  const fScore = fieldScore !== undefined ? fieldScore : scoreField(areas, maxEccentricityDeg, calibration)
  if (fScore != null) {
    const fraction = fScore.overallFraction
    // Constricted once we leave the normal/borderline band — matches the stage.
    const constricted = fScore.band.severity !== 'normal' && fScore.band.severity !== 'borderline'
    findings.push({
      tone: constricted ? 'warning' : 'ok',
      label: 'Concentric field constriction',
      description: constricted
        ? `The visual field is constricted concentrically (overall field score ${fScore.score}/100 — ~${(fraction * 100).toFixed(0)}% of normal averaged across isopters). This is the hallmark pattern of retinitis pigmentosa — the field narrows inward from all sides like a tunnel.`
        : `The field covers ~${(fraction * 100).toFixed(0)}% of normal across isopters (field score ${fScore.score}/100) and does not show significant concentric constriction. This is a positive sign.`,
      present: constricted,
    })
  }

  // 2. Ring scotoma — detected via disproportionate drop between
  //    consecutive isopter areas. Distinct from the `detectFieldPatterns`
  //    overlay: that one annotates the severity chip, this one is a
  //    free-standing RP-indicator card with its own phrasing.
  if (v4e != null && iii4e != null && iii2e != null) {
    const ordered = [
      { label: 'V4e', area: v4e },
      { label: 'III4e', area: iii4e },
      { label: 'III2e', area: iii2e },
      ...(i4e != null ? [{ label: 'I4e', area: i4e }] : []),
      ...(i2e != null ? [{ label: 'I2e', area: i2e }] : []),
    ]
    let hasRingScotoma = false
    let dropOuterLabel = ''
    let dropInnerLabel = ''
    let dropOuterArea = 0
    let dropInnerArea = 0
    for (let i = 0; i < ordered.length - 1; i++) {
      const ratio = ordered[i + 1].area / ordered[i].area
      if (ratio < 0.30 && ordered[i].area > 500) {
        hasRingScotoma = true
        dropOuterLabel = ordered[i].label
        dropInnerLabel = ordered[i + 1].label
        dropOuterArea = ordered[i].area
        dropInnerArea = ordered[i + 1].area
        break
      }
    }
    findings.push({
      tone: hasRingScotoma ? 'warning' : 'muted',
      label: 'Ring scotoma pattern',
      description: hasRingScotoma
        ? `There is a disproportionate drop from ${dropOuterLabel} (${dropOuterArea.toFixed(0)} deg²) to ${dropInnerLabel} (${dropInnerArea.toFixed(0)} deg²) — the inner field is only ${((dropInnerArea / dropOuterArea) * 100).toFixed(0)}% of the outer. This suggests a ring scotoma — a band of vision loss in the mid-periphery with preserved central and far-peripheral vision. This is characteristic of mid-stage RP.`
        : 'No clear ring scotoma detected. The isopters decrease proportionally without a large mid-peripheral gap.',
      present: hasRingScotoma,
    })
  }

  // 3. Rod-mediated sensitivity loss — dim stimuli lost disproportionately.
  //    RP affects rod photoreceptors first → dim-light sensitivity drops
  //    before bright-light sensitivity.
  if (iii4e != null && iii2e != null && iii4e > 0) {
    const dimRatio = iii2e / iii4e
    const scotopicLoss = dimRatio < 0.30
    findings.push({
      tone: scotopicLoss ? 'warning' : 'ok',
      label: 'Rod-mediated sensitivity loss',
      description: scotopicLoss
        ? `Dim stimuli (III2e) are detected in only ${(dimRatio * 100).toFixed(0)}% of the area where bright stimuli (III4e) are seen. This disproportionate loss of dim-light sensitivity is consistent with rod photoreceptor degeneration — the earliest and most characteristic feature of RP.`
        : `Dim stimulus detection (III2e) covers ${(dimRatio * 100).toFixed(0)}% of the bright stimulus field (III4e). Rod-mediated sensitivity is relatively preserved.`,
      present: scotopicLoss,
    })
  }

  // 4. Preserved central island — typical of RP until late stages.
  if (i2e != null && iii4e != null && iii4e > 0) {
    const centralPreserved = i2e > 20 && iii4e < 2000
    const centralToTotal = i2e / iii4e
    const veryLimited = i2e <= 20
    findings.push({
      tone: centralPreserved ? 'info' : veryLimited ? 'critical' : 'ok',
      label: 'Central island preservation',
      description: centralPreserved
        ? `Fine central vision (I2e: ${i2e.toFixed(0)} deg²) is preserved relative to the peripheral field (III4e: ${iii4e.toFixed(0)} deg²). Central island ratio: ${(centralToTotal * 100).toFixed(0)}%. This "tunnel vision" pattern — good central acuity with peripheral loss — is typical of RP.`
        : veryLimited
          ? `Central fine vision (I2e: ${i2e.toFixed(0)} deg²) is very limited, suggesting the disease may be affecting the macula. This can indicate advanced RP or associated macular involvement.`
          : 'Central vision preservation is proportional to the overall field — no specific tunnel pattern detected.',
      present: centralPreserved || veryLimited,
    })
  }

  // 5. Superior-inferior asymmetry — inferior field often affected
  //    earlier in RP.
  const iii4eDetected = points.filter(p => p.stimulus === 'III4e' && p.detected)
  if (iii4eDetected.length >= 8) {
    const superior = iii4eDetected.filter(p => p.meridianDeg >= 30 && p.meridianDeg <= 150)
    const inferior = iii4eDetected.filter(p => p.meridianDeg >= 210 && p.meridianDeg <= 330)
    if (superior.length >= 2 && inferior.length >= 2) {
      const supMean = superior.reduce((s, p) => s + p.eccentricityDeg, 0) / superior.length
      const infMean = inferior.reduce((s, p) => s + p.eccentricityDeg, 0) / inferior.length
      const ratio = Math.min(supMean, infMean) / Math.max(supMean, infMean)
      const asymmetric = ratio < 0.65
      const moreAffected = supMean < infMean ? 'superior' : 'inferior'
      findings.push({
        tone: asymmetric ? 'caution' : 'muted',
        label: 'Vertical field asymmetry',
        description: asymmetric
          ? `The ${moreAffected} visual field is more constricted (${moreAffected === 'superior' ? supMean.toFixed(0) : infMean.toFixed(0)}° vs ${moreAffected === 'superior' ? infMean.toFixed(0) : supMean.toFixed(0)}°). ${moreAffected === 'inferior' ? 'Inferior field loss preceding superior is a common early pattern in RP.' : 'Superior field loss can occur in RP and other retinal conditions.'}`
          : `The superior and inferior fields are relatively symmetric (${supMean.toFixed(0)}° vs ${infMean.toFixed(0)}°). Symmetric constriction is typical of classic RP.`,
        present: asymmetric,
      })
    }
  }

  // 6. Brightness-size dissociation — small bright I4e covers more area
  //    than large dim III2e, consistent with preferential rod loss.
  if (i4e != null && iii2e != null) {
    const dissociation = i4e > iii2e * 1.2
    findings.push({
      tone: dissociation ? 'info' : 'muted',
      label: 'Brightness-size dissociation',
      description: dissociation
        ? `The small bright stimulus (I4e: ${i4e.toFixed(0)} deg²) is detected over a larger area than the large dim stimulus (III2e: ${iii2e.toFixed(0)} deg²). This brightness-over-size preference is characteristic of RP — damaged rods lose dim-light sensitivity while cones retain bright-light detection.`
        : 'Stimulus size and brightness sensitivity are proportional — no dissociation detected.',
      present: dissociation,
    })
  }

  return findings
}

// ── Anomaly detection ────────────────────────────────────────────────
// Data-quality / artifact flags. These live outside the Tone/Finding
// system because they map to a distinct 3-band icon scheme (ℹ / ⚠ / ✕)
// in both renderers.

export function detectAnomalies(
  points: TestPoint[],
  areas: Partial<Record<StimulusKey, number>>,
): Anomaly[] {
  const anomalies: Anomaly[] = []

  // Detected (non-catch-trial) point count per isopter. An isopter mapped from
  // only a handful of points yields an unreliable polygon area — common in
  // phone-VR where the dim/small stimuli (III2e, I2e) are barely visible, so
  // their isopter collapses to a tiny area. Comparing such a sparse isopter to
  // a well-mapped neighbour produces spurious "inner larger than outer" flags,
  // so we require both isopters in a comparison to have enough points first.
  const MIN_RELIABLE_ISOPTER_POINTS = 4
  const detectedCount = (stim: StimulusKey): number =>
    points.filter(p => p.stimulus === stim && p.detected && !p.catchTrial).length

  // 1. Inner isopter larger than outer. Mild overlap between adjacent
  //    isopters is very common in RP (steep sensitivity gradient,
  //    constricted fields, brightness vs size differences), so adjacent
  //    pairs (gap = 1) need a lenient 3× threshold; non-adjacent pairs
  //    use a stricter 2× since they should never be close to reversal.
  for (let i = 0; i < ISOPTER_ORDER.length - 1; i++) {
    for (let j = i + 1; j < ISOPTER_ORDER.length; j++) {
      const outer = ISOPTER_ORDER[i]
      const inner = ISOPTER_ORDER[j]
      const outerArea = areas[outer]
      const innerArea = areas[inner]
      if (outerArea == null || innerArea == null) continue
      // Don't flag an ordering reversal when either isopter is too sparse to
      // have a trustworthy area (e.g. a dim stimulus barely seen in a headset).
      if (
        detectedCount(outer) < MIN_RELIABLE_ISOPTER_POINTS ||
        detectedCount(inner) < MIN_RELIABLE_ISOPTER_POINTS
      ) {
        continue
      }

      const gap = j - i
      const threshold = gap === 1 ? 3.0 : 2.0
      if (innerArea > outerArea * threshold) {
        anomalies.push({
          icon: 'warning',
          tone: 'caution',
          label: `${STIMULI[inner].label} isopter much larger than ${STIMULI[outer].label}`,
          description: `The ${STIMULI[inner].label} isopter (${innerArea.toFixed(0)} deg²) is unexpectedly larger than the ${STIMULI[outer].label} isopter (${outerArea.toFixed(0)} deg²). This may indicate a measurement issue — consider retesting.`,
        })
        break // One warning per inner isopter is enough.
      }
    }
  }

  // Innermost > outermost is physiologically impossible — flag it even
  // if the nested loop above already caught it, because the wording is
  // much stronger.
  const v4e = areas['V4e']
  const i2e = areas['I2e']
  if (
    v4e != null && i2e != null && i2e > v4e * 1.1 &&
    detectedCount('V4e') >= MIN_RELIABLE_ISOPTER_POINTS &&
    detectedCount('I2e') >= MIN_RELIABLE_ISOPTER_POINTS
  ) {
    anomalies.push({
      icon: 'error',
      tone: 'critical',
      label: 'Innermost isopter larger than outermost',
      description: `The I2e isopter (${i2e.toFixed(0)} deg²) is larger than V4e (${v4e.toFixed(0)} deg²). This is physiologically unlikely and suggests significant testing artifacts or fixation issues.`,
    })
  }

  // 2. High shape irregularity per isopter (coefficient of variation of
  //    eccentricity across its detected points).
  for (const stim of ISOPTER_ORDER) {
    const detected = points.filter(p => p.stimulus === stim && p.detected)
    if (detected.length < 6) continue
    const eccs = detected.map(p => p.eccentricityDeg)
    const mean = eccs.reduce((s, v) => s + v, 0) / eccs.length
    if (mean < 2) continue // too small to assess
    const variance = eccs.reduce((s, v) => s + (v - mean) ** 2, 0) / eccs.length
    const cv = Math.sqrt(variance) / mean
    if (cv > 0.50) {
      anomalies.push({
        icon: 'warning',
        tone: 'caution',
        label: `Irregular ${STIMULI[stim].label} isopter shape`,
        description: `The ${STIMULI[stim].label} boundary is highly irregular (CV=${(cv * 100).toFixed(0)}%). This can be caused by attention lapses, inconsistent fixation, or true scotoma irregularity. Consider retesting for confirmation.`,
      })
    }
  }

  // 3. Vertical asymmetry — a data-quality flag version of the pattern
  //    modifier. Uses a stricter threshold (smaller/bigger < 0.5) than
  //    `detectAsymmetryPattern` (< 0.65) on purpose: the modifier is a
  //    routine finding to display, the anomaly is a prompt to retest or
  //    consult an ophthalmologist.
  const iii4eDetected = points.filter(p => p.stimulus === 'III4e' && p.detected)
  if (iii4eDetected.length >= 8) {
    const superior = iii4eDetected.filter(p => p.meridianDeg >= 30 && p.meridianDeg <= 150)
    const inferior = iii4eDetected.filter(p => p.meridianDeg >= 210 && p.meridianDeg <= 330)
    if (superior.length >= 2 && inferior.length >= 2) {
      const supMean = superior.reduce((s, p) => s + p.eccentricityDeg, 0) / superior.length
      const infMean = inferior.reduce((s, p) => s + p.eccentricityDeg, 0) / inferior.length
      const bigger = Math.max(supMean, infMean)
      const smaller = Math.min(supMean, infMean)
      if (bigger > 0 && smaller / bigger < 0.5) {
        const moreAffected = supMean < infMean ? 'superior' : 'inferior'
        anomalies.push({
          icon: 'info',
          tone: 'info',
          label: 'Marked vertical asymmetry',
          description: `The ${moreAffected} field is significantly more constricted than the opposite half. While some asymmetry is common in RP, marked differences should be discussed with your ophthalmologist to rule out other causes.`,
        })
      }
    }
  }

  // 4. Very low detection rate for an isopter. Exclude catch trials: a
  //    detected catch trial is a false positive, not a real detection, so
  //    counting it would inflate the rate and mask a genuine low-detection
  //    isopter (consistent with detectedCount above, which already filters
  //    catch trials).
  for (const stim of ISOPTER_ORDER) {
    const stimPoints = points.filter(p => p.stimulus === stim && !p.catchTrial)
    if (stimPoints.length < 4) continue
    const detectedCount = stimPoints.filter(p => p.detected).length
    const rate = detectedCount / stimPoints.length
    if (rate < 0.25) {
      anomalies.push({
        icon: 'info',
        tone: 'info',
        label: `Very low detection for ${STIMULI[stim].label}`,
        description: `Only ${(rate * 100).toFixed(0)}% of ${STIMULI[stim].label} stimuli were detected (${detectedCount}/${stimPoints.length}). This could indicate severe field loss at this stimulus level, or attention/fixation issues during testing.`,
      })
    }
  }

  return anomalies
}
