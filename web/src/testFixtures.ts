/**
 * Synthetic test data for different clinical severity levels.
 * Used for visual verification of radar maps, vision simulator, and interpretation.
 */
import type { TestPoint, StimulusKey, CalibrationData } from './types'
import { getGrid24_2 } from './grids/hfa24_2'
import { DB_MIN, DB_MAX } from './sensitivity'

export interface ClinicalScenario {
  id: string
  label: string
  description: string
  severity: string // e.g. 'Normal', 'Mild', 'Moderate', 'Severe', 'Very Severe'
  points: TestPoint[]
  /** Matching static-threshold sample points (HFA 24-2 grid, per-location
   *  dB via a synthetic severity profile). Drives the demo-page static
   *  sensitivity companion panel so both Goldmann and static visualisations
   *  of the same severity sit side-by-side. */
  staticPoints?: TestPoint[]
  maxEccentricity: number
  calibration: CalibrationData
}

/** Synthetic per-location severity profile for generating static threshold
 *  fixtures. A profile describes how each location's healthy baseline dB is
 *  perturbed to simulate a clinical pattern. */
export interface SeverityProfile {
  id: string
  /** Uniform penalty subtracted from every location. */
  globalDepression?: number
  /** Extra penalty proportional to eccentricity: `slope * r` dB. Simulates
   *  peripheral loss (classic RP). */
  peripheralSlope?: number
  /** Scotoma bands: locations with eccentricity in [rMin, rMax] lose
   *  `depth` dB. Multiple bands stack (max depth wins). */
  scotomaBands?: Array<{ rMin: number; rMax: number; depth: number }>
  /** Extra penalty applied to inferior-field points (y < 0). */
  inferiorPenalty?: number
  /** Tunnel vision: locations outside this radius lose `tunnelOuterDepression` dB. */
  tunnelRadius?: number
  tunnelOuterDepression?: number
}

const MERIDIANS_12 = Array.from({ length: 12 }, (_, i) => i * 30)
const MERIDIANS_24 = Array.from({ length: 24 }, (_, i) => i * 15)

/** Deterministic pseudo-random noise — consistent across renders */
function pseudoRandom(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return x - Math.floor(x) // 0 to 1
}

/** Generate detected points around a given radius with deterministic noise */
function makeIsopter(
  stimulus: StimulusKey,
  meridians: number[],
  baseRadius: number,
  noise: number = 1,
  asymmetry?: { inferiorPenalty?: number; temporalBonus?: number },
): TestPoint[] {
  const seed = stimulus.charCodeAt(0) * 13 + stimulus.charCodeAt(stimulus.length - 1) * 7
  return meridians.map(m => {
    let r = baseRadius + (pseudoRandom(m, seed) - 0.5) * noise * 2

    // Vertical asymmetry — inferior field (210–330°) more constricted
    if (asymmetry?.inferiorPenalty && m >= 210 && m <= 330) {
      r -= asymmetry.inferiorPenalty
    }
    // Temporal bonus (0° for right eye)
    if (asymmetry?.temporalBonus && (m <= 30 || m >= 330)) {
      r += asymmetry.temporalBonus
    }

    r = Math.max(1, r)

    return {
      meridianDeg: m,
      eccentricityDeg: r,
      rawEccentricityDeg: r + 0.5,
      detected: true,
      stimulus,
    }
  })
}

/** Generate not-detected points beyond the field boundary (deterministic) */
function makeMisses(
  stimulus: StimulusKey,
  meridians: number[],
  beyondRadius: number,
): TestPoint[] {
  const seed = stimulus.charCodeAt(0) * 17 + stimulus.charCodeAt(stimulus.length - 1) * 11
  return meridians.filter((m) => pseudoRandom(m, seed + 99) > 0.5).map(m => ({
    meridianDeg: m,
    eccentricityDeg: beyondRadius + pseudoRandom(m, seed + 50) * 5,
    rawEccentricityDeg: beyondRadius + pseudoRandom(m, seed + 50) * 5 + 0.5,
    detected: false,
    stimulus,
  }))
}

/** Ring scotoma: detected inside, missed in mid-periphery, detected again far out */
export function makeRingScotoma(
  stimulus: StimulusKey,
  meridians: number[],
  innerRadius: number,
  scotomaStart: number,
  scotomaEnd: number,
  outerRadius: number,
  noise: number = 1,
): TestPoint[] {
  const seed = stimulus.charCodeAt(0) * 19 + stimulus.charCodeAt(stimulus.length - 1) * 13
  const points: TestPoint[] = []

  for (const m of meridians) {
    // Inner detected
    const r1 = innerRadius + (pseudoRandom(m, seed) - 0.5) * noise
    points.push({
      meridianDeg: m,
      eccentricityDeg: Math.max(1, r1),
      rawEccentricityDeg: Math.max(1, r1) + 0.5,
      detected: true,
      stimulus,
    })

    // Mid-peripheral miss
    const rMiss = (scotomaStart + scotomaEnd) / 2 + (pseudoRandom(m, seed + 33) - 0.5) * noise
    points.push({
      meridianDeg: m,
      eccentricityDeg: rMiss,
      rawEccentricityDeg: rMiss + 0.5,
      detected: false,
      stimulus,
    })

    // Outer detected (far periphery preserved)
    const r2 = outerRadius + (pseudoRandom(m, seed + 66) - 0.5) * noise
    points.push({
      meridianDeg: m,
      eccentricityDeg: Math.max(scotomaEnd + 1, r2),
      rawEccentricityDeg: Math.max(scotomaEnd + 1, r2) + 0.5,
      detected: true,
      stimulus,
    })
  }

  return points
}

const baseCal: CalibrationData = {
  pixelsPerDegree: 20,
  maxEccentricityDeg: 50,
  viewingDistanceCm: 40,
  brightnessFloor: 0.05,
  reactionTimeMs: 350,
  fixationOffsetPx: -200,
  screenWidthPx: 1440,
  screenHeightPx: 900,
}

// ────────────────────────────────────────────────────
// 1. NORMAL / HEALTHY
// ────────────────────────────────────────────────────
function normalField(): ClinicalScenario {
  const pts = [
    ...makeIsopter('V4e', MERIDIANS_24, 70, 2),   // well beyond display edge
    ...makeIsopter('III4e', MERIDIANS_24, 55, 2),
    ...makeIsopter('III2e', MERIDIANS_12, 42, 2),
    ...makeIsopter('I4e', MERIDIANS_12, 32, 2),
    ...makeIsopter('I2e', MERIDIANS_12, 22, 2),
  ]
  return {
    id: 'normal',
    label: 'Normal',
    description: 'Full visual field with all isopters well within normal limits. V4e extends to ~55°, I2e ~20°.',
    severity: 'Normal',
    points: pts,
    maxEccentricity: 50,
    calibration: baseCal,
  }
}

// ────────────────────────────────────────────────────
// 2. EARLY RP — borderline constriction
// ────────────────────────────────────────────────────
function earlyRP(): ClinicalScenario {
  const pts = [
    ...makeIsopter('V4e', MERIDIANS_24, 42, 1.5, { inferiorPenalty: 5 }),
    ...makeIsopter('III4e', MERIDIANS_24, 32, 1.5, { inferiorPenalty: 5 }),
    ...makeIsopter('III2e', MERIDIANS_12, 22, 1.5, { inferiorPenalty: 3 }),
    ...makeIsopter('I4e', MERIDIANS_12, 16, 1.5),
    ...makeIsopter('I2e', MERIDIANS_12, 12, 1),
    ...makeMisses('V4e', MERIDIANS_12, 44),
    ...makeMisses('III4e', MERIDIANS_12, 34),
  ]
  return {
    id: 'early-rp',
    label: 'Early RP',
    description: 'Mild peripheral constriction with inferior field affected first. V4e ~38°, III4e ~30°.',
    severity: 'Mild',
    points: pts,
    maxEccentricity: 50,
    calibration: baseCal,
  }
}

// ────────────────────────────────────────────────────
// 3. MODERATE RP — clear constriction
// ────────────────────────────────────────────────────
function moderateRP(): ClinicalScenario {
  const pts = [
    ...makeIsopter('V4e', MERIDIANS_24, 25, 1.5, { inferiorPenalty: 5, temporalBonus: 3 }),
    ...makeIsopter('III4e', MERIDIANS_24, 18, 1.5, { inferiorPenalty: 4 }),
    ...makeIsopter('III2e', MERIDIANS_12, 10, 1),
    ...makeIsopter('I4e', MERIDIANS_12, 8, 1),
    ...makeIsopter('I2e', MERIDIANS_12, 5, 0.8),
    ...makeMisses('V4e', MERIDIANS_12, 28),
    ...makeMisses('III4e', MERIDIANS_12, 20),
    ...makeMisses('III2e', MERIDIANS_12, 13),
  ]
  return {
    id: 'moderate-rp',
    label: 'Moderate RP',
    description: 'Significant constriction — tunnel vision developing. V4e ~25°, III4e ~18°. Dim stimuli barely detected.',
    severity: 'Moderate',
    points: pts,
    maxEccentricity: 50,
    calibration: baseCal,
  }
}

// ────────────────────────────────────────────────────
// 4. SEVERE RP — tunnel vision
// ────────────────────────────────────────────────────
function severeRP(): ClinicalScenario {
  const pts = [
    ...makeIsopter('V4e', MERIDIANS_24, 14, 1.5),
    ...makeIsopter('III4e', MERIDIANS_24, 10, 1.5),
    ...makeIsopter('III2e', MERIDIANS_12, 5, 1),
    ...makeIsopter('I4e', MERIDIANS_12, 4, 0.8),
    ...makeIsopter('I2e', MERIDIANS_12, 2.5, 0.5),
    ...makeMisses('V4e', MERIDIANS_12, 16),
    ...makeMisses('III4e', MERIDIANS_12, 12),
    ...makeMisses('III2e', MERIDIANS_12, 7),
    ...makeMisses('I4e', MERIDIANS_12, 5),
  ]
  return {
    id: 'severe-rp',
    label: 'Severe RP',
    description: 'Classic tunnel vision. V4e ~14°, III4e ~10°. Meets legal blindness criteria (≤20° diameter).',
    severity: 'Severe',
    points: pts,
    maxEccentricity: 50,
    calibration: baseCal,
  }
}

// ────────────────────────────────────────────────────
// 5. VERY SEVERE RP — tiny central island
// ────────────────────────────────────────────────────
function verySevereRP(): ClinicalScenario {
  const pts = [
    ...makeIsopter('V4e', MERIDIANS_24, 7, 1),
    ...makeIsopter('III4e', MERIDIANS_24, 5, 0.8),
    ...makeIsopter('III2e', MERIDIANS_12, 3, 0.5),
    ...makeIsopter('I4e', MERIDIANS_12, 2, 0.4),
    ...makeIsopter('I2e', MERIDIANS_12, 1.2, 0.3),
    ...makeMisses('V4e', MERIDIANS_12, 9),
    ...makeMisses('III4e', MERIDIANS_12, 7),
    ...makeMisses('III2e', MERIDIANS_12, 4),
    ...makeMisses('I4e', MERIDIANS_12, 3),
    ...makeMisses('I2e', MERIDIANS_12, 2),
  ]
  return {
    id: 'very-severe-rp',
    label: 'Very Severe RP',
    description: 'Tiny central island only. V4e ~7°, III4e ~5°. Near-total field loss.',
    severity: 'Very Severe',
    points: pts,
    maxEccentricity: 50,
    calibration: baseCal,
  }
}

// ────────────────────────────────────────────────────
// 6. RING SCOTOMA — mid-stage RP pattern
// ────────────────────────────────────────────────────
function ringScotoma(): ClinicalScenario {
  // In a ring scotoma, there's a band of lost vision in the mid-periphery.
  // For the radar: each isopter is ONE smooth curve (the outer boundary).
  // The scotoma is shown via missed points between the inner and outer isopters.
  const pts = [
    // V4e outer boundary — far peripheral vision preserved at ~42°
    ...makeIsopter('V4e', MERIDIANS_24, 42, 1.5),
    // III4e outer boundary — at ~36°
    ...makeIsopter('III4e', MERIDIANS_24, 36, 1.5),
    // III2e — only detected centrally at ~10° (can't penetrate scotoma)
    ...makeIsopter('III2e', MERIDIANS_12, 10, 1),
    // I4e — central at ~8°
    ...makeIsopter('I4e', MERIDIANS_12, 8, 1),
    // I2e — small central at ~5°
    ...makeIsopter('I2e', MERIDIANS_12, 5, 0.8),
    // Misses in the scotoma band (18–30°) for multiple stimuli
    ...makeMisses('V4e', MERIDIANS_24, 22),
    ...makeMisses('III4e', MERIDIANS_24, 20),
    ...makeMisses('III2e', MERIDIANS_12, 16),
  ]
  return {
    id: 'ring-scotoma',
    label: 'Ring Scotoma',
    description: 'Mid-peripheral scotoma band with preserved central and far-peripheral vision. V4e outer boundary ~42°, III2e only central ~10°.',
    severity: 'Moderate (Ring)',
    points: pts,
    maxEccentricity: 50,
    calibration: baseCal,
  }
}

// ────────────────────────────────────────────────────
// 7. ASYMMETRIC RP — inferior field more affected
// ────────────────────────────────────────────────────
function asymmetricRP(): ClinicalScenario {
  const pts = [
    ...makeIsopter('V4e', MERIDIANS_24, 28, 2, { inferiorPenalty: 14 }),
    ...makeIsopter('III4e', MERIDIANS_24, 22, 2, { inferiorPenalty: 12 }),
    ...makeIsopter('III2e', MERIDIANS_12, 14, 2, { inferiorPenalty: 8 }),
    ...makeIsopter('I4e', MERIDIANS_12, 10, 1.5, { inferiorPenalty: 4 }),
    ...makeIsopter('I2e', MERIDIANS_12, 7, 1),
    ...makeMisses('III4e', MERIDIANS_12, 24),
  ]
  return {
    id: 'asymmetric-rp',
    label: 'Asymmetric RP',
    description: 'Inferior visual field significantly more constricted than superior. Superior ~28°, Inferior ~14° for V4e.',
    severity: 'Moderate (Asymmetric)',
    points: pts,
    maxEccentricity: 50,
    calibration: baseCal,
  }
}

// ────────────────────────────────────────────────────
// 8. DOUBLE RING / SWISS CHEESE — multiple scotoma bands
// ────────────────────────────────────────────────────
function doubleRingScotoma(): ClinicalScenario {
  const pts = [
    ...makeIsopter('V4e', MERIDIANS_24, 45, 1.5),
    ...makeIsopter('III4e', MERIDIANS_24, 38, 1.5),
    ...makeIsopter('III2e', MERIDIANS_12, 24, 1.5),
    ...makeIsopter('I4e', MERIDIANS_12, 20, 1),
    ...makeIsopter('I2e', MERIDIANS_12, 6, 0.8),
    ...makeMisses('V4e', MERIDIANS_24, 32),
    ...makeMisses('III4e', MERIDIANS_24, 30),
    ...makeMisses('III2e', MERIDIANS_12, 14),
    ...makeMisses('I4e', MERIDIANS_12, 12),
  ]
  return {
    id: 'double-ring-scotoma',
    label: 'Double Ring Scotoma',
    description: 'Two concentric scotoma bands with preserved vision between them. Outer band ~30-38°, inner band ~12-18°.',
    severity: 'Moderate (Multi-Ring)',
    points: pts,
    maxEccentricity: 50,
    calibration: baseCal,
  }
}

/** Severity profiles for the static-threshold companion fixtures. Each
 *  profile describes the per-location dB perturbation pattern that matches
 *  the corresponding Goldmann scenario above. The exact patterns are not
 *  clinical ground truth — they just need to produce visually recognisable
 *  static maps at the same severity level as their Goldmann counterparts. */
export const SCENARIO_PROFILES: Record<string, SeverityProfile> = {
  normal: {
    id: 'normal',
  },
  earlyRP: {
    id: 'earlyRP',
    globalDepression: 3,
    peripheralSlope: 0.2,
    inferiorPenalty: 2,
  },
  moderateRP: {
    id: 'moderateRP',
    globalDepression: 8,
    peripheralSlope: 0.3,
    inferiorPenalty: 2,
  },
  severeRP: {
    id: 'severeRP',
    tunnelRadius: 10,
    // Drops outer dB below zero so the profile reaches the absolute-scotoma
    // sentinel (DB_MIN = -5) and renders as vivid red, not warm orange.
    tunnelOuterDepression: 35,
    globalDepression: 2,
  },
  verySevereRP: {
    id: 'verySevereRP',
    tunnelRadius: 6,
    tunnelOuterDepression: 40,
    globalDepression: 4,
  },
  ringScotoma: {
    id: 'ringScotoma',
    scotomaBands: [{ rMin: 7, rMax: 17, depth: 18 }],
  },
  doubleRingScotoma: {
    id: 'doubleRingScotoma',
    scotomaBands: [
      { rMin: 6, rMax: 11, depth: 14 },
      { rMin: 18, rMax: 26, depth: 16 },
    ],
  },
  asymmetricRP: {
    id: 'asymmetricRP',
    globalDepression: 4,
    peripheralSlope: 0.25,
    inferiorPenalty: 10,
  },
}

/** Healthy baseline sensitivity (dB) at a given eccentricity. Mirrors the
 *  hill-of-vision shape: high centrally, tapering toward the periphery,
 *  floored at 20 dB to keep the normal map legible. */
function healthyBaselineDb(r: number): number {
  return Math.max(20, 30 - r / 5)
}

/** Cartesian grid matching the 24-2 rectangular extent (±28° × ±22°) at a
 *  given spacing. Used by the demo to feed the sensitivity renderer a
 *  dense enough sample set that the Gaussian smoother produces smooth
 *  round contours instead of a blocky per-sample lattice. */
function buildDenseDemoGrid(stepDeg: number): Array<{ xDeg: number; yDeg: number; key: string }> {
  const out: Array<{ xDeg: number; yDeg: number; key: string }> = []
  for (let y = -22; y <= 22; y += stepDeg) {
    for (let x = -28; x <= 28; x += stepDeg) {
      out.push({ xDeg: x, yDeg: y, key: `${x},${y}` })
    }
  }
  return out
}

/** Generate a static-threshold fixture for a given severity profile.
 *  Output has one TestPoint per grid location with `thresholdDb` set,
 *  `stimulus: 'III4e'`, `detected: true`. Values are deterministic.
 *
 *  Default grid is the clinical HFA 24-2 pattern (54 locations, 6° spacing)
 *  so outputs match what a real threshold run would produce. Pass
 *  `denseStepDeg` to use a tighter Cartesian grid instead — useful for the
 *  demo page, where the sparse 24-2 lattice shows through the heatmap's
 *  Gaussian smoother as a visibly square pattern. */
export function makeStaticThresholdPoints(
  profile: SeverityProfile,
  denseStepDeg?: number,
): TestPoint[] {
  const grid = denseStepDeg ? buildDenseDemoGrid(denseStepDeg) : getGrid24_2('right')
  const out: TestPoint[] = []
  for (const g of grid) {
    const r = Math.sqrt(g.xDeg * g.xDeg + g.yDeg * g.yDeg)
    const meridianDeg = ((Math.atan2(g.yDeg, g.xDeg) * 180) / Math.PI + 360) % 360
    let db = healthyBaselineDb(r)
    if (profile.globalDepression) db -= profile.globalDepression
    if (profile.peripheralSlope) db -= profile.peripheralSlope * r
    if (profile.scotomaBands) {
      let bandDepth = 0
      for (const band of profile.scotomaBands) {
        if (r >= band.rMin && r <= band.rMax && band.depth > bandDepth) {
          bandDepth = band.depth
        }
      }
      db -= bandDepth
    }
    if (profile.inferiorPenalty && g.yDeg < 0) db -= profile.inferiorPenalty
    if (
      profile.tunnelRadius != null &&
      profile.tunnelOuterDepression != null &&
      r > profile.tunnelRadius
    ) {
      db -= profile.tunnelOuterDepression
    }
    // Deterministic ±1 dB jitter so the map doesn't look suspiciously flat.
    const noise = (pseudoRandom(g.xDeg, g.yDeg) - 0.5) * 2
    db += noise
    // Clamp to the display range ([DB_MIN, DB_MAX]), not [0, 40] — the
    // sub-zero sentinel represents "absolute scotoma" (even max brightness
    // not seen) and is what makes severe regions render vivid red instead
    // of warm orange at the colormap's amber edge.
    db = Math.max(DB_MIN, Math.min(DB_MAX, db))
    out.push({
      meridianDeg,
      eccentricityDeg: r,
      rawEccentricityDeg: r,
      detected: true,
      stimulus: 'III4e',
      thresholdDb: db,
    })
  }
  return out
}

/** All scenarios in order from best to worst */
export function getAllScenarios(): ClinicalScenario[] {
  const builders: Array<[() => ClinicalScenario, keyof typeof SCENARIO_PROFILES]> = [
    [normalField, 'normal'],
    [earlyRP, 'earlyRP'],
    [moderateRP, 'moderateRP'],
    [ringScotoma, 'ringScotoma'],
    [doubleRingScotoma, 'doubleRingScotoma'],
    [asymmetricRP, 'asymmetricRP'],
    [severeRP, 'severeRP'],
    [verySevereRP, 'verySevereRP'],
  ]
  return builders.map(([build, profileKey]) => {
    const scenario = build()
    // Dense 2° grid for demo-page rendering — sparse 24-2 grid shows the
    // sample lattice as a visible square pattern under the Gaussian smoother.
    scenario.staticPoints = makeStaticThresholdPoints(SCENARIO_PROFILES[profileKey], 2)
    return scenario
  })
}
