import { useState } from 'react'
import type { TestPoint, StimulusKey, CalibrationData, TestResult } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { classifyFieldLoss, type FieldSeverity } from '../clinicalClassifications'
import { computeReliability } from '../reliabilityScore'
import { computeReliabilityIndices } from '../reliabilityIndices'
import { RELIABILITY_REFERENCE_RANGES } from '../testDefaults'

// ── Field classification thresholds (percent of testable area) ──
// A screen-based test cannot reach the full clinical 90° field. We classify
// the III4e isopter as a percentage of the area a healthy eye would cover
// within the *actual* screen-bounded testable region, so the same retina
// gets the same verdict on a phone vs a desktop monitor regardless of
// aspect ratio or fixation offset.

interface Classification {
  label: string
  color: string     // tailwind text color
  bgColor: string   // tailwind bg color
  description: string
}

/** Tailwind theme + long-form description per severity band. Labels and
 *  thresholds come from ../clinicalClassifications so both the in-app
 *  panel and the PDF export stay in lockstep on clinical grading. */
const CLASSIFICATION_THEMES: Record<FieldSeverity, { color: string; bgColor: string; description: string }> = {
  'very-severe': {
    color: 'text-red-400',
    bgColor: 'bg-red-500/10 border-red-500/30',
    description:
      'Less than ~5% of the testable field is detected. This indicates a tiny central island of vision remaining. Daily activities and mobility are severely affected.',
  },
  severe: {
    color: 'text-red-400',
    bgColor: 'bg-red-500/10 border-red-500/30',
    description:
      'Roughly 5–20% of the testable field is detected. This degree of constriction often meets criteria for legal blindness when the central field is ≤ 20° diameter. Significant mobility challenges are likely.',
  },
  moderate: {
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/10 border-orange-500/30',
    description:
      'Roughly 20–45% of the testable field is detected. Peripheral awareness is reduced. Night vision and navigation in unfamiliar environments may be affected.',
  },
  mild: {
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/10 border-yellow-500/30',
    description:
      'Roughly 45–70% of the testable field is detected. Some peripheral loss is present but central vision is well preserved. You may notice difficulty in dim lighting.',
  },
  borderline: {
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10 border-blue-500/30',
    description:
      'Roughly 70–85% of the testable field is detected. The field is near-normal with possible early constriction, though this may also reflect normal variation or test conditions.',
  },
  normal: {
    color: 'text-green-400',
    bgColor: 'bg-green-500/10 border-green-500/30',
    description:
      'More than ~85% of the testable field is detected — within normal limits for the tested range. Note that a screen-based test cannot cover the full clinical field; a clinical Goldmann test assesses out to 90°.',
  },
}

/**
 * Expected normal III4e area for a screen-bounded test.
 *
 * The correct reference is the area a healthy eye *could* cover on the
 * specific screen the test was run on — i.e., the rectangle formed by the
 * screen, measured from the offset fixation, in degree-space. Previously
 * this used `π × maxEccentricityDeg²`, which assumes a full circular
 * testable field at the largest edge distance. On a typical 16:9 monitor
 * with a horizontal fixation offset, that overstates the real testable
 * area by ~2.5×, pushing even near-full fields into the "severe
 * constriction" bracket when they're actually perfectly normal within
 * the screen limits.
 *
 * We compute the area of the largest ellipse that fits inside the screen
 * rectangle — (π/4) × (screenWidth × screenHeight) / ppd² — using the
 * calibration recorded at test time. The rectangle area itself would
 * overstate the normal reference because a biological isopter is a
 * smooth rounded shape that physically cannot fill the screen corners,
 * so every normal field would be flagged as "mild constriction" at
 * ~78.5% of rectangle area. The inscribed ellipse is a much closer
 * match to the shape of a healthy III4e isopter clamped to the screen
 * rectangle. When the caller doesn't supply full calibration (legacy
 * call sites, pre-0.3.0 OVFX imports with no stored screen dimensions),
 * we fall back to π × maxEccentricityDeg² — the circular inscribed
 * fallback that matches the old square-screen approximation.
 */
function expectedNormalArea(
  maxEccentricityDeg: number,
  calibration?: CalibrationData,
): number {
  if (calibration?.screenWidthPx != null && calibration?.screenHeightPx != null) {
    const widthDeg = calibration.screenWidthPx / calibration.pixelsPerDegree
    const heightDeg = calibration.screenHeightPx / calibration.pixelsPerDegree
    return (Math.PI / 4) * widthDeg * heightDeg
  }
  // Fallback: inscribed circle of a square screen where maxEcc is the radius.
  return Math.PI * maxEccentricityDeg * maxEccentricityDeg
}

/**
 * Pattern modifier — ring scotoma, double-ring, asymmetry, and similar
 * overlay findings that can coexist with any severity tier. Previously these
 * were rendered by `classifyField` as a replacement for the constriction
 * tier, which forced users with both "Early RP constriction" *and* a ring
 * scotoma to see only one of the two. Modifiers are now additive.
 */
interface PatternModifier {
  key: string
  label: string
  color: string
  bgColor: string
  description: string
}

/** Detect a ring scotoma and return a modifier (if any). The label encodes
 *  ring severity and whether multiple bands are present. */
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
      label: `Ring scotoma — severe${multiSuffix}`,
      color: 'text-red-400',
      bgColor: 'bg-red-500/10 border-red-500/30',
      description: `A ring-shaped scotoma is present${multiText}. Continuous central vision extends only ~${innerRadius.toFixed(0)}° before a mid-peripheral blind band. The far periphery may still be preserved, but the functional field is severely limited.`,
    }
  } else if (innerArea <= 800) {
    return {
      key: 'ring-scotoma',
      label: `Ring scotoma — moderate${multiSuffix}`,
      color: 'text-orange-400',
      bgColor: 'bg-orange-500/10 border-orange-500/30',
      description: `A ring-shaped scotoma is present${multiText} in the mid-periphery. Central vision is preserved to ~${innerRadius.toFixed(0)}° with peripheral vision beyond the scotoma band. This is a characteristic mid-stage RP pattern.`,
    }
  }
  return {
    key: 'ring-scotoma',
    label: `Ring scotoma — mild${multiSuffix}`,
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/10 border-yellow-500/30',
    description: `A mild ring scotoma pattern is detected${multiText}. Central vision is relatively well preserved (~${innerRadius.toFixed(0)}° radius) but there is a band of reduced sensitivity in the mid-periphery.`,
  }
}

/** Detect vertical superior/inferior asymmetry from the III4e detected points. */
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
    label: 'Vertical field asymmetry',
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/10 border-yellow-500/30',
    description: `The ${moreAffected} visual field is more constricted (${moreVal.toFixed(0)}° vs ${lessVal.toFixed(0)}°). ${moreAffected === 'inferior' ? 'Inferior field loss preceding superior is a common early pattern in RP.' : 'Superior field loss can occur in RP and other retinal conditions.'}`,
  }
}

/** Detect all additive pattern modifiers for a result. */
function detectFieldPatterns(
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

/**
 * Classify the OVERALL constriction severity of the field. Always based on
 * the III4e fraction of the testable area — even when a ring scotoma or
 * vertical asymmetry is present. Those patterns are reported separately via
 * `detectFieldPatterns` so a user with, e.g., early-RP constriction *plus*
 * a ring scotoma sees both findings rather than having one hide the other.
 */
function classifyField(
  iii4eArea: number,
  maxEccentricityDeg: number,
  calibration?: CalibrationData,
): Classification {
  const fraction = iii4eArea / expectedNormalArea(maxEccentricityDeg, calibration)
  const band = classifyFieldLoss(fraction)
  const theme = CLASSIFICATION_THEMES[band.severity]
  return { label: band.label, color: theme.color, bgColor: theme.bgColor, description: theme.description }
}

// ── Sensitivity gradient analysis ──
interface GradientInsight {
  label: string
  description: string
  color: string
}

function analyzeSensitivityGradient(
  areas: Partial<Record<StimulusKey, number>>,
): GradientInsight | null {
  const iii4e = areas['III4e']
  const iii2e = areas['III2e']
  if (iii4e == null || iii2e == null || iii4e === 0) return null

  // For severely constricted fields, the gradient ratio is less meaningful —
  // both isopters are tiny and their ratio reflects proportional constriction
  // rather than differential sensitivity loss. Skip the analysis.
  if (iii4e < 500) return null

  const ratio = iii2e / iii4e
  if (ratio < 0.05) {
    return {
      label: 'Steep sensitivity drop-off',
      description:
        'The dim stimulus (III2e) is barely seen compared to the bright one (III4e). This suggests a sharp boundary between functioning and non-functioning retina — typical of RP scotomas.',
      color: 'text-orange-400',
    }
  } else if (ratio < 0.20) {
    return {
      label: 'Significant sensitivity gradient',
      description:
        'There is a large difference between bright (III4e) and dim (III2e) stimulus detection. The retina in the mid-periphery has reduced sensitivity even where it still detects bright stimuli.',
      color: 'text-yellow-400',
    }
  } else if (ratio < 0.50) {
    return {
      label: 'Moderate sensitivity gradient',
      description:
        'The sensitivity gradient between bright and dim stimuli is moderate. Some retinal sensitivity loss is present in areas that still detect larger or brighter targets.',
      color: 'text-blue-400',
    }
  }
  return {
    label: 'Preserved sensitivity',
    description:
      'Dim stimuli are detected across a reasonable portion of the field. Retinal sensitivity is relatively well-preserved where the field is intact.',
    color: 'text-green-400',
  }
}

// ── Central island analysis ──
function analyzeCentralIsland(
  areas: Partial<Record<StimulusKey, number>>,
): GradientInsight | null {
  const i2e = areas['I2e']
  if (i2e == null) return null

  if (i2e < 10) {
    return {
      label: 'Very small central island',
      description:
        'Fine detail vision (I2e) is limited to less than ~2° radius. Reading and tasks requiring fine acuity may be significantly affected.',
      color: 'text-red-400',
    }
  } else if (i2e < 50) {
    return {
      label: 'Small central island',
      description:
        'Fine detail vision (I2e) is present but limited to a small central area (~2–4° radius). Central acuity may still be functional for reading with appropriate aids.',
      color: 'text-orange-400',
    }
  } else if (i2e < 200) {
    return {
      label: 'Moderate central field',
      description:
        'Fine detail vision (I2e) covers a moderate central area. Central function is relatively well preserved.',
      color: 'text-yellow-400',
    }
  }
  return {
    label: 'Good central field',
    description:
      'Fine detail vision (I2e) is present across a healthy central area. Central retinal function appears well preserved.',
    color: 'text-green-400',
  }
}

// ── RP-specific findings ──
interface RPFinding {
  label: string
  description: string
  color: string // tailwind text color
  present: boolean
}

function detectRPFindings(
  points: TestPoint[],
  areas: Partial<Record<StimulusKey, number>>,
  maxEccentricityDeg: number,
  calibration?: CalibrationData,
): RPFinding[] {
  const findings: RPFinding[] = []

  const v4e = areas['V4e']
  const iii4e = areas['III4e']
  const iii2e = areas['III2e']
  const i4e = areas['I4e']
  const i2e = areas['I2e']

  // 1. Concentric constriction — hallmark of RP
  //    Compared against the screen-bounded testable area, not a clinical 90° bowl.
  if (iii4e != null) {
    const equivRadius = Math.sqrt(iii4e / Math.PI)
    const fraction = iii4e / expectedNormalArea(maxEccentricityDeg, calibration)
    const constricted = fraction < 0.65
    findings.push({
      label: 'Concentric field constriction',
      description: constricted
        ? `The visual field is constricted concentrically (III4e covers ~${(fraction * 100).toFixed(0)}% of the testable area, equivalent radius ~${equivRadius.toFixed(0)}°). This is the hallmark pattern of retinitis pigmentosa — the field narrows inward from all sides like a tunnel.`
        : `The III4e field covers ~${(fraction * 100).toFixed(0)}% of the testable area (radius ~${equivRadius.toFixed(0)}°) and does not show significant concentric constriction. This is a positive sign.`,
      color: constricted ? 'text-orange-400' : 'text-green-400',
      present: constricted,
    })
  }

  // 2. Ring scotoma — mid-peripheral loss with preserved central and far-peripheral
  //    Detected via disproportionate drop between consecutive isopter areas.
  //    In ring scotoma, outer isopters (V4e/III4e) are large but inner (III2e) drops sharply.
  if (v4e != null && iii4e != null && iii2e != null) {
    // Check for large area drops between consecutive isopters
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
      label: 'Ring scotoma pattern',
      description: hasRingScotoma
        ? `There is a disproportionate drop from ${dropOuterLabel} (${dropOuterArea.toFixed(0)} deg²) to ${dropInnerLabel} (${dropInnerArea.toFixed(0)} deg²) — the inner field is only ${((dropInnerArea / dropOuterArea) * 100).toFixed(0)}% of the outer. This suggests a ring scotoma — a band of vision loss in the mid-periphery with preserved central and far-peripheral vision. This is characteristic of mid-stage RP.`
        : 'No clear ring scotoma detected. The isopters decrease proportionally without a large mid-peripheral gap.',
      color: hasRingScotoma ? 'text-orange-400' : 'text-gray-500',
      present: hasRingScotoma,
    })
  }

  // 3. Scotopic sensitivity loss — dim stimuli lost disproportionately
  //    RP affects rod photoreceptors first → dim-light sensitivity drops before bright
  if (iii4e != null && iii2e != null && iii4e > 0) {
    const dimRatio = iii2e / iii4e
    const scotopicLoss = dimRatio < 0.30
    findings.push({
      label: 'Rod-mediated sensitivity loss',
      description: scotopicLoss
        ? `Dim stimuli (III2e) are detected in only ${(dimRatio * 100).toFixed(0)}% of the area where bright stimuli (III4e) are seen. This disproportionate loss of dim-light sensitivity is consistent with rod photoreceptor degeneration — the earliest and most characteristic feature of RP.`
        : `Dim stimulus detection (III2e) covers ${(dimRatio * 100).toFixed(0)}% of the bright stimulus field (III4e). Rod-mediated sensitivity is relatively preserved.`,
      color: scotopicLoss ? 'text-orange-400' : 'text-green-400',
      present: scotopicLoss,
    })
  }

  // 4. Preserved central island — typical of RP until late stages
  if (i2e != null && iii4e != null && iii4e > 0) {
    const centralPreserved = i2e > 20 && (iii4e < 2000)
    const centralToTotal = i2e / iii4e
    findings.push({
      label: 'Central island preservation',
      description: centralPreserved
        ? `Fine central vision (I2e: ${i2e.toFixed(0)} deg²) is preserved relative to the peripheral field (III4e: ${iii4e.toFixed(0)} deg²). Central island ratio: ${(centralToTotal * 100).toFixed(0)}%. This "tunnel vision" pattern — good central acuity with peripheral loss — is typical of RP.`
        : i2e != null && i2e <= 20
          ? `Central fine vision (I2e: ${i2e.toFixed(0)} deg²) is very limited, suggesting the disease may be affecting the macula. This can indicate advanced RP or associated macular involvement.`
          : 'Central vision preservation is proportional to the overall field — no specific tunnel pattern detected.',
      color: centralPreserved ? 'text-blue-400' : i2e != null && i2e <= 20 ? 'text-red-400' : 'text-green-400',
      present: centralPreserved || (i2e != null && i2e <= 20),
    })
  }

  // 5. Superior-inferior asymmetry — inferior field often affected earlier in RP
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
        label: 'Vertical field asymmetry',
        description: asymmetric
          ? `The ${moreAffected} visual field is more constricted (${moreAffected === 'superior' ? supMean.toFixed(0) : infMean.toFixed(0)}° vs ${moreAffected === 'superior' ? infMean.toFixed(0) : supMean.toFixed(0)}°). ${moreAffected === 'inferior' ? 'Inferior field loss preceding superior is a common early pattern in RP.' : 'Superior field loss can occur in RP and other retinal conditions.'}`
          : `The superior and inferior fields are relatively symmetric (${supMean.toFixed(0)}° vs ${infMean.toFixed(0)}°). Symmetric constriction is typical of classic RP.`,
        color: asymmetric ? 'text-yellow-400' : 'text-gray-500',
        present: asymmetric,
      })
    }
  }

  // 6. Brightness vs size dissociation — I4e (small bright) > III2e (large dim)
  if (i4e != null && iii2e != null) {
    const dissociation = i4e > iii2e * 1.2
    findings.push({
      label: 'Brightness-size dissociation',
      description: dissociation
        ? `The small bright stimulus (I4e: ${i4e.toFixed(0)} deg²) is detected over a larger area than the large dim stimulus (III2e: ${iii2e.toFixed(0)} deg²). This brightness-over-size preference is characteristic of RP — damaged rods lose dim-light sensitivity while cones retain bright-light detection.`
        : 'Stimulus size and brightness sensitivity are proportional — no dissociation detected.',
      color: dissociation ? 'text-blue-400' : 'text-gray-500',
      present: dissociation,
    })
  }

  return findings
}

// ── Anomaly detection ──
interface Anomaly {
  label: string
  description: string
  severity: 'info' | 'warning' | 'error'
}

function detectAnomalies(
  points: TestPoint[],
  areas: Partial<Record<StimulusKey, number>>,
): Anomaly[] {
  const anomalies: Anomaly[] = []

  // 1. Inner isopter larger than outer — only flag extreme reversals as anomalies.
  //    Mild overlap between adjacent isopters is very common in RP (steep sensitivity
  //    gradient, constricted fields, brightness vs size sensitivity differences).
  //    Adjacent pairs (e.g., III2e vs I4e) need a high threshold (3×) since
  //    RP patients often retain brightness sensitivity better than size sensitivity.
  //    Non-adjacent pairs use a stricter threshold (2×).
  for (let i = 0; i < ISOPTER_ORDER.length - 1; i++) {
    for (let j = i + 1; j < ISOPTER_ORDER.length; j++) {
      const outer = ISOPTER_ORDER[i]
      const inner = ISOPTER_ORDER[j]
      const outerArea = areas[outer]
      const innerArea = areas[inner]
      if (outerArea == null || innerArea == null) continue

      // Adjacent pairs: very lenient (3×). Non-adjacent: stricter (2×).
      const gap = j - i
      const threshold = gap === 1 ? 3.0 : 2.0
      if (innerArea > outerArea * threshold) {
        anomalies.push({
          label: `${STIMULI[inner].label} isopter much larger than ${STIMULI[outer].label}`,
          description: `The ${STIMULI[inner].label} isopter (${innerArea.toFixed(0)} deg²) is unexpectedly larger than the ${STIMULI[outer].label} isopter (${outerArea.toFixed(0)} deg²). This may indicate a measurement issue — consider retesting.`,
          severity: 'warning',
        })
        break // One warning per inner isopter is enough
      }
    }
  }

  // Also check non-adjacent pairs (e.g., I2e > V4e) which should never happen
  const v4e = areas['V4e']
  const i2e = areas['I2e']
  if (v4e != null && i2e != null && i2e > v4e * 1.1) {
    anomalies.push({
      label: 'Innermost isopter larger than outermost',
      description: `The I2e isopter (${i2e.toFixed(0)} deg²) is larger than V4e (${v4e.toFixed(0)} deg²). This is physiologically unlikely and suggests significant testing artifacts or fixation issues.`,
      severity: 'error',
    })
  }

  // 2. High shape irregularity per isopter (coefficient of variation of eccentricity)
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
        label: `Irregular ${STIMULI[stim].label} isopter shape`,
        description: `The ${STIMULI[stim].label} boundary is highly irregular (CV=${(cv * 100).toFixed(0)}%). This can be caused by attention lapses, inconsistent fixation, or true scotoma irregularity. Consider retesting for confirmation.`,
        severity: 'warning',
      })
    }
  }

  // 3. Asymmetry analysis (temporal vs nasal for III4e)
  const iii4eDetected = points.filter(p => p.stimulus === 'III4e' && p.detected)
  if (iii4eDetected.length >= 8) {
    // Superior (90-270° in math coords maps to meridians 0-180° roughly)
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
          label: `Marked vertical asymmetry`,
          description: `The ${moreAffected} field is significantly more constricted than the opposite half. While some asymmetry is common in RP, marked differences should be discussed with your ophthalmologist to rule out other causes.`,
          severity: 'info',
        })
      }
    }
  }

  // 4. Many missed points (low detection rate)
  for (const stim of ISOPTER_ORDER) {
    const stimPoints = points.filter(p => p.stimulus === stim)
    if (stimPoints.length < 4) continue
    const detectedCount = stimPoints.filter(p => p.detected).length
    const rate = detectedCount / stimPoints.length
    if (rate < 0.25) {
      anomalies.push({
        label: `Very low detection for ${STIMULI[stim].label}`,
        description: `Only ${(rate * 100).toFixed(0)}% of ${STIMULI[stim].label} stimuli were detected (${detectedCount}/${stimPoints.length}). This could indicate severe field loss at this stimulus level, or attention/fixation issues during testing.`,
        severity: 'info',
      })
    }
  }

  return anomalies
}

// ── Main component ──
interface Props {
  points: TestPoint[]
  areas: Partial<Record<StimulusKey, number>>
  maxEccentricityDeg: number
  /** Full calibration from the test run. When provided, classification
   *  uses the actual screen rectangle area as the "normal" reference
   *  instead of the circular π × maxEcc² approximation. Optional so
   *  legacy/demo call sites still compile. */
  calibration?: CalibrationData
  /** Raw catch-trial + response counters from the test run, used to render
   *  Fixation Accuracy and False-Positive Response Rate. Absent on demo
   *  and legacy results — the section is simply hidden in that case. */
  reliabilityIndices?: TestResult['reliabilityIndices']
}

export function Interpretation({ points, areas, maxEccentricityDeg, calibration, reliabilityIndices }: Props) {
  const [expanded, setExpanded] = useState(false)

  const iii4eArea = areas['III4e']
  const classification = iii4eArea != null ? classifyField(iii4eArea, maxEccentricityDeg, calibration) : null
  const patterns = detectFieldPatterns(points, areas)
  const gradient = analyzeSensitivityGradient(areas)
  const centralIsland = analyzeCentralIsland(areas)
  const rpFindings = detectRPFindings(points, areas, maxEccentricityDeg, calibration).filter(f => f.present)
  const anomalies = detectAnomalies(points, areas)
  const reliability = computeReliability(points, areas)
  const reliabilityIdx = computeReliabilityIndices({ reliabilityIndices })
  const expectedArea = expectedNormalArea(maxEccentricityDeg, calibration)

  return (
    <div className="space-y-3">
      {/* Toggle button */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left px-4 py-3 bg-gray-900 hover:bg-gray-800 rounded-xl border border-gray-800 transition-colors flex items-center justify-between"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium">Interpretation</span>
          {classification && (
            <span className={`text-xs ${classification.color}`}>{classification.label}</span>
          )}
          {patterns.map(p => (
            <span
              key={p.key}
              className={`text-xs px-1.5 py-0.5 rounded border ${p.bgColor} ${p.color}`}
            >
              {p.label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {/* Reliability badge */}
          <span className={`text-xs ${reliability.color} font-mono`}>
            Reliability: {reliability.score}%
          </span>
          <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 px-1">
          {/* Reliability score */}
          <div className="bg-gray-900 rounded-xl p-4 space-y-3 border border-gray-800">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-300">Test reliability</h3>
              <span className={`text-lg font-mono font-semibold ${reliability.color}`}>
                {reliability.score}/100
              </span>
            </div>
            <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${reliability.score}%`,
                  backgroundColor:
                    reliability.score >= 85
                      ? '#4ade80'
                      : reliability.score >= 65
                        ? '#facc15'
                        : reliability.score >= 40
                          ? '#fb923c'
                          : '#f87171',
                }}
              />
            </div>
            {reliability.factors.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {reliability.factors.map((f, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-red-400 font-mono shrink-0">-{f.penalty}</span>
                    <span className="text-gray-400">{f.detail}</span>
                  </div>
                ))}
              </div>
            )}
            {reliability.factors.length === 0 && (
              <p className="text-xs text-gray-500">No reliability issues detected.</p>
            )}
          </div>

          {/* Fixation Accuracy + False-Positive Response Rate — reference ranges
              from Dzwiniel et al., PLoS ONE 2017 (n=21 healthy controls). Only
              shown when the test recorded catch trials. */}
          {reliabilityIdx.fa && (
            <div className="bg-gray-900 rounded-xl p-4 space-y-3 border border-gray-800">
              <h3 className="text-sm font-medium text-gray-300">Reliability indices</h3>
              <div className="space-y-2 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="text-gray-300 font-medium">Fixation accuracy (FA)</div>
                    <div className="text-gray-500">
                      {reliabilityIdx.fa.correct}/{reliabilityIdx.fa.presented} catch trials correctly ignored · normal {RELIABILITY_REFERENCE_RANGES.faPercent.min}–{RELIABILITY_REFERENCE_RANGES.faPercent.max}%
                    </div>
                    <div
                      className={
                        reliabilityIdx.fa.band === 'normal'
                          ? 'text-green-400'
                          : reliabilityIdx.fa.band === 'borderline'
                            ? 'text-yellow-400'
                            : 'text-red-400'
                      }
                    >
                      {reliabilityIdx.fa.bandLabel}
                    </div>
                  </div>
                  <div
                    className={`font-mono text-lg shrink-0 ${
                      reliabilityIdx.fa.band === 'normal'
                        ? 'text-green-400'
                        : reliabilityIdx.fa.band === 'borderline'
                          ? 'text-yellow-400'
                          : 'text-red-400'
                    }`}
                  >
                    {reliabilityIdx.fa.percent.toFixed(0)}%
                  </div>
                </div>
                {reliabilityIdx.fprr && (
                  <div className="flex items-start justify-between gap-3 pt-2 border-t border-gray-800">
                    <div className="flex-1">
                      <div className="text-gray-300 font-medium">False-positive response rate (FPRR)</div>
                      <div className="text-gray-500">
                        {reliabilityIdx.fprr.falsePositives}/{reliabilityIdx.fprr.total} responses were false positives · normal {RELIABILITY_REFERENCE_RANGES.fprrPercent.min}–{RELIABILITY_REFERENCE_RANGES.fprrPercent.max}%
                      </div>
                      <div
                        className={
                          reliabilityIdx.fprr.band === 'normal'
                            ? 'text-green-400'
                            : reliabilityIdx.fprr.band === 'elevated'
                              ? 'text-yellow-400'
                              : 'text-red-400'
                        }
                      >
                        {reliabilityIdx.fprr.bandLabel}
                      </div>
                    </div>
                    <div
                      className={`font-mono text-lg shrink-0 ${
                        reliabilityIdx.fprr.band === 'normal'
                          ? 'text-green-400'
                          : reliabilityIdx.fprr.band === 'elevated'
                            ? 'text-yellow-400'
                            : 'text-red-400'
                      }`}
                    >
                      {reliabilityIdx.fprr.percent.toFixed(1)}%
                    </div>
                  </div>
                )}
                <p className="text-gray-600 text-[10px] pt-1">
                  Reference ranges: {RELIABILITY_REFERENCE_RANGES.citation}
                </p>
              </div>
            </div>
          )}

          {/* Field classification — the headline severity tier. Additive
              pattern modifiers (ring scotoma, asymmetry) are rendered as
              separate cards below so they don't hide the base severity. */}
          {classification && (
            <div className={`rounded-xl p-4 border ${classification.bgColor}`}>
              <h3 className={`text-sm font-medium ${classification.color} mb-2`}>
                {classification.label}
              </h3>
              <p className="text-xs text-gray-300 leading-relaxed">{classification.description}</p>
              {iii4eArea != null && (
                <p className="text-xs text-gray-500 mt-2">
                  III4e isopter: {iii4eArea.toFixed(0)} deg² (~{((iii4eArea / expectedArea) * 100).toFixed(0)}% of testable area, equivalent radius ~{Math.sqrt(iii4eArea / Math.PI).toFixed(1)}°)
                </p>
              )}
            </div>
          )}

          {/* Pattern modifiers — ring scotoma, asymmetry, etc. These can
              coexist with any severity tier and are reported additively. */}
          {patterns.map(p => (
            <div key={p.key} className={`rounded-xl p-4 border ${p.bgColor}`}>
              <h3 className={`text-sm font-medium ${p.color} mb-2`}>{p.label}</h3>
              <p className="text-xs text-gray-300 leading-relaxed">{p.description}</p>
            </div>
          ))}

          {/* Sensitivity gradient */}
          {gradient && (
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <h3 className={`text-sm font-medium ${gradient.color} mb-2`}>{gradient.label}</h3>
              <p className="text-xs text-gray-300 leading-relaxed">{gradient.description}</p>
            </div>
          )}

          {/* Central island */}
          {centralIsland && (
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <h3 className={`text-sm font-medium ${centralIsland.color} mb-2`}>
                {centralIsland.label}
              </h3>
              <p className="text-xs text-gray-300 leading-relaxed">{centralIsland.description}</p>
            </div>
          )}

          {/* RP-specific findings */}
          {rpFindings.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider px-1">
                RP indicators
              </h3>
              {rpFindings.map((f, i) => (
                <div
                  key={i}
                  className="bg-gray-900 rounded-xl p-4 border border-gray-800"
                >
                  <h4 className={`text-sm font-medium ${f.color} mb-1`}>{f.label}</h4>
                  <p className="text-xs text-gray-300 leading-relaxed">{f.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* Anomalies */}
          {anomalies.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider px-1">
                Anomalies detected
              </h3>
              {anomalies.map((a, i) => (
                <div
                  key={i}
                  className={`rounded-xl p-4 border ${
                    a.severity === 'error'
                      ? 'bg-red-500/10 border-red-500/30'
                      : a.severity === 'warning'
                        ? 'bg-yellow-500/10 border-yellow-500/30'
                        : 'bg-blue-500/10 border-blue-500/30'
                  }`}
                >
                  <h4
                    className={`text-sm font-medium mb-1 ${
                      a.severity === 'error'
                        ? 'text-red-400'
                        : a.severity === 'warning'
                          ? 'text-yellow-400'
                          : 'text-blue-400'
                    }`}
                  >
                    {a.severity === 'warning' ? '⚠ ' : a.severity === 'error' ? '✕ ' : 'ℹ '}
                    {a.label}
                  </h4>
                  <p className="text-xs text-gray-300 leading-relaxed">{a.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* Disclaimer */}
          <p className="text-xs text-gray-600 leading-relaxed px-1">
            This tool has not been validated against a clinical perimeter. This interpretation
            is generated automatically for self-monitoring purposes only. Results may differ
            from clinical perimetry due to screen limitations, uncontrolled viewing distance,
            and the absence of standardized testing conditions. Always consult your
            ophthalmologist for diagnosis and treatment decisions. Use this tool to notice
            changes in your own field — not as a reliable clinical indicator.
          </p>
        </div>
      )}
    </div>
  )
}
