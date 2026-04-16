import { useRef, useState, useEffect, useCallback } from 'react'
import type { TestPoint, Eye, StimulusKey } from '../types'
import { ISOPTER_ORDER } from '../types'
import { formatEyeLabelForResult } from '../eyeLabels'
import { APP_NAME } from '../branding'

interface Props {
  points: TestPoint[]
  eye: Eye
  maxEccentricity: number
  /** Optional second eye data for binocular simulation */
  secondEyePoints?: TestPoint[]
  secondEyeMaxEccentricity?: number
}

// Curated Unsplash photos showing real scenarios difficult with tunnel vision
const SCENE_OPTIONS = [
  {
    label: 'Crossing',
    url: 'https://images.unsplash.com/photo-1517732306149-e8f829eb588a?w=1200&h=800&fit=crop&auto=format',
    // Busy pedestrian crosswalk — navigating traffic
  },
  {
    label: 'Handshake',
    url: 'https://images.unsplash.com/photo-1600880292203-757bb62b4baf?w=1200&h=800&fit=crop&auto=format',
    // People greeting / handshake — finding an extended hand
  },
  {
    label: 'Grocery',
    url: 'https://images.unsplash.com/photo-1604719312566-8912e9227c6a?w=1200&h=800&fit=crop&auto=format',
    // Supermarket aisle — scanning shelves
  },
  {
    label: 'Stairs',
    url: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1200&h=800&fit=crop&auto=format',
    // Staircase — depth and edges
  },
  {
    label: 'Crowd',
    url: 'https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=1200&h=800&fit=crop&auto=format',
    // Crowd of people — finding someone in a group
  },
]
const DEFAULT_SCENE_URL = SCENE_OPTIONS[0].url

type BoundaryPoint = { angleDeg: number; normalizedRadius: number }
interface IsopterBoundary {
  stimulusKey: StimulusKey
  /** Index in ISOPTER_ORDER: 0=V4e (outermost) … 4=I2e (innermost) */
  orderIdx: number
  points: BoundaryPoint[]
}

/**
 * Build boundaries for ALL available isopters, tagged by stimulus key.
 * Smooths the boundary by resampling to 360 points (1° resolution)
 * using cubic interpolation for organic shapes.
 */
/**
 * Bin detected points into angular sectors and return the outermost
 * detected eccentricity per sector (same approach as VisualFieldMap).
 * Works cleanly for scattered (static) data where meridians are arbitrary floats.
 */
function binBoundary(
  allDetected: TestPoint[],
  binSizeDeg: number,
): { meridianDeg: number; eccentricityDeg: number }[] {
  if (allDetected.length < 3) return []

  const numBins = Math.round(360 / binSizeDeg)
  const bins: (number | null)[] = new Array(numBins).fill(null)

  for (const p of allDetected) {
    const bin = Math.round(((p.meridianDeg % 360 + 360) % 360) / binSizeDeg) % numBins
    if (bins[bin] === null || p.eccentricityDeg > bins[bin]!) {
      bins[bin] = p.eccentricityDeg
    }
  }

  // Interpolate gaps from nearest filled neighbors
  const filled = bins.map((v, i) => {
    if (v !== null) return v
    for (let d = 1; d <= numBins / 2; d++) {
      const prev = bins[(i - d + numBins) % numBins]
      const next = bins[(i + d) % numBins]
      if (prev !== null && next !== null) return (prev + next) / 2
      if (prev !== null) return prev
      if (next !== null) return next
    }
    return 0
  })

  return filled.map((ecc, i) => ({
    meridianDeg: i * binSizeDeg,
    eccentricityDeg: ecc,
  }))
}

function buildTaggedBoundaries(
  points: TestPoint[],
  maxEccentricity: number,
): IsopterBoundary[] {
  const boundaries: IsopterBoundary[] = []
  for (let idx = 0; idx < ISOPTER_ORDER.length; idx++) {
    const key = ISOPTER_ORDER[idx]
    const allDetected = points.filter(p => p.stimulus === key && p.detected)
    if (allDetected.length < 3) continue

    // Determine if data is scattered (static test) vs structured (Goldmann/ring)
    const isScattered = allDetected.length > 20

    let raw: BoundaryPoint[]

    if (isScattered) {
      // Scattered data: bin into angular sectors for clean boundaries
      const binSize = 5
      const binned = binBoundary(allDetected, binSize)
      raw = binned.map(p => ({
        angleDeg: p.meridianDeg,
        normalizedRadius: Math.min(1.4, p.eccentricityDeg / maxEccentricity),
      }))
    } else {
      // Structured data: use outermost detected point per exact meridian
      const byMeridian = new Map<number, TestPoint>()
      for (const p of allDetected) {
        const existing = byMeridian.get(p.meridianDeg)
        if (!existing || p.eccentricityDeg > existing.eccentricityDeg) {
          byMeridian.set(p.meridianDeg, p)
        }
      }
      const detected = [...byMeridian.values()]
      if (detected.length < 3) continue
      const sorted = [...detected].sort((a, b) => a.meridianDeg - b.meridianDeg)
      raw = sorted.map(p => ({
        angleDeg: p.meridianDeg,
        normalizedRadius: Math.min(1.4, p.eccentricityDeg / maxEccentricity),
      }))
    }

    if (raw.length < 3) continue

    // Resample to smooth 1° resolution using cubic interpolation
    const smooth = resampleBoundary(raw, 360)
    // Vision simulator is approximate — circularize each isopter so meridian
    // sampling artifacts (rectangular screen, fixation offset, sparse Goldmann
    // meridians) don't produce lopsided scotoma rings. The clinical
    // VisualFieldMap preserves the original directional geometry.
    const finalBoundary = circularizeBoundary(smooth)
    boundaries.push({ stimulusKey: key, orderIdx: idx, points: finalBoundary })
  }

  // Enforce the nesting invariant: at every angle, a dimmer isopter must not
  // exceed any brighter one. Without this, noisy measurements where a dim
  // isopter bulges past a brighter one at a few angles produce the "double
  // ring scotoma" artifact — getVisionQuality's gap detection interprets
  // the local overlap as a ring scotoma band at some angles and not
  // others, so the simulator renders alternating blacked/visible sectors.
  // Clamping the dimmer to cap at the running minimum of all brighter
  // isopters at the same angle makes the gap function monotonic and the
  // simulator output consistent. Sorting by orderIdx ensures we walk
  // outer → inner even if insertion order differed.
  boundaries.sort((a, b) => a.orderIdx - b.orderIdx)
  if (boundaries.length >= 2) {
    const refLength = boundaries[0].points.length
    const runningMin = new Array<number>(refLength)
    for (let i = 0; i < refLength; i++) runningMin[i] = boundaries[0].points[i].normalizedRadius
    for (let bi = 1; bi < boundaries.length; bi++) {
      const pts = boundaries[bi].points
      const n = pts.length
      const clamped = pts.map((p, i) => {
        // Map this boundary's index into the reference boundary by angle
        // so length mismatches still clamp correctly.
        const refIdx = n === refLength ? i : Math.round((p.angleDeg / 360) * refLength) % refLength
        const cap = runningMin[refIdx]
        return { ...p, normalizedRadius: Math.min(p.normalizedRadius, cap) }
      })
      boundaries[bi] = { ...boundaries[bi], points: clamped }
      // Update running minimum for the next inner isopter.
      for (let i = 0; i < refLength; i++) {
        const refIdx = n === refLength ? i : Math.round((i / refLength) * n) % n
        if (clamped[refIdx].normalizedRadius < runningMin[i]) {
          runningMin[i] = clamped[refIdx].normalizedRadius
        }
      }
    }
  }

  // Rescale so the outermost isopter fills most of the simulator image.
  // Without this, radii are normalised against maxEccentricityDeg (the
  // longest edge distance from fixation — e.g. 80° on a wide monitor), so
  // a user whose entire field sits inside 30° sees their entire pattern
  // squashed into the inner ~37% of the simulated image. The scotoma ring
  // is then visually tiny and doesn't reflect the clinical severity. Fix:
  // stretch all boundaries so the outermost mean radius reaches OUTER_FRAC
  // of the simulator edge. Internal ratios (and therefore gap detection)
  // are preserved; only the overall scale shifts so the user can actually
  // see their ring scotoma.
  //
  // Normal bypass: if the outermost radius is already ≥ 0.90 the user's
  // field reaches the screen edge and any further stretch would push it
  // off the image — `getVisionQuality`'s >1.05 bypass already shows a
  // clean image in that case, so leave it alone.
  const OUTER_FRAC = 0.92
  if (boundaries.length > 0) {
    const outerMean = boundaries[0].points.reduce((s, p) => s + p.normalizedRadius, 0) / boundaries[0].points.length
    if (outerMean > 0.001 && outerMean < 0.90) {
      const scale = OUTER_FRAC / outerMean
      for (let bi = 0; bi < boundaries.length; bi++) {
        boundaries[bi] = {
          ...boundaries[bi],
          points: boundaries[bi].points.map(p => ({
            ...p,
            normalizedRadius: p.normalizedRadius * scale,
          })),
        }
      }
    }
  }

  return boundaries
}

/**
 * Resample a sparse boundary (e.g. 12 points) into N evenly-spaced points
 * using Catmull-Rom cubic interpolation, then heavily smooth the result
 * with multiple gaussian-like passes for organic round shapes.
 */
function resampleBoundary(raw: BoundaryPoint[], count: number): BoundaryPoint[] {
  if (raw.length < 3) return raw
  const n = raw.length

  // Step 1: Interpolation to count points.
  // Use linear for sparse data (≤24 raw points) to prevent cubic overshoot
  // artifacts that create dark wedges in ring scotoma patterns. Linear can't
  // overshoot — the smoothing passes afterward provide organic roundness.
  // Use cubic Catmull-Rom only for dense data (>24 points) where it's stable.
  const useCubic = n > 24
  const radii = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const targetAngle = (i / count) * 360

    let idx1 = n - 1
    for (let j = 0; j < n; j++) {
      if (raw[j].angleDeg >= targetAngle) {
        idx1 = (j - 1 + n) % n
        break
      }
    }
    const idx2 = (idx1 + 1) % n

    const a1 = raw[idx1].angleDeg
    let a2 = raw[idx2].angleDeg
    let ta = targetAngle
    if (a2 <= a1) a2 += 360
    if (ta < a1) ta += 360
    const range = a2 - a1
    const t = range > 0 ? Math.max(0, Math.min(1, (ta - a1) / range)) : 0

    const r1 = raw[idx1].normalizedRadius
    const r2 = raw[idx2].normalizedRadius

    if (useCubic) {
      const idx0 = (idx1 - 1 + n) % n
      const idx3 = (idx1 + 2) % n
      const r0 = raw[idx0].normalizedRadius
      const r3 = raw[idx3].normalizedRadius
      const t2 = t * t
      const t3 = t2 * t
      const unclamped = 0.5 * (
        (2 * r1) +
        (-r0 + r2) * t +
        (2 * r0 - 5 * r1 + 4 * r2 - r3) * t2 +
        (-r0 + 3 * r1 - 3 * r2 + r3) * t3
      )
      radii[i] = Math.max(0, unclamped)
    } else {
      // Linear interpolation — no overshoot possible
      radii[i] = r1 + (r2 - r1) * t
    }
  }

  // Step 2: Multiple smoothing passes (circular gaussian-like kernel).
  // Any Goldmann/ring test (≤24 raw points) needs aggressive smoothing: gaps
  // between detected meridians can be 30–45°, and a narrow kernel leaves bumps
  // that appear as clear-vision "spikes" and dark patches in the simulation.
  // Only truly dense data (static test, binned to 72 pts) uses the narrow kernel.
  const isSparse = n <= 24
  const SMOOTH_PASSES = isSparse ? 16 : 5
  const KERNEL_HALF = isSparse ? 40 : 15 // ±40° for sparse, ±15° for dense
  const tmp = new Float64Array(count)

  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    for (let i = 0; i < count; i++) {
      let sum = 0
      let wsum = 0
      for (let k = -KERNEL_HALF; k <= KERNEL_HALF; k++) {
        const j = ((i + k) % count + count) % count
        // Gaussian-like weight
        const w = Math.exp(-(k * k) / (2 * (KERNEL_HALF / 2) ** 2))
        sum += radii[j] * w
        wsum += w
      }
      tmp[i] = sum / wsum
    }
    radii.set(tmp)
  }

  // Build result
  const result: BoundaryPoint[] = []
  for (let i = 0; i < count; i++) {
    result.push({ angleDeg: (i / count) * 360, normalizedRadius: radii[i] })
  }
  return result
}

/**
 * Enforce 4-fold symmetry on a resampled boundary by averaging each angle with
 * its three reflections (across the vertical axis, the horizontal axis, and
 * both). Coordinate system: 0°=right, 90°=up, 180°=left, 270°=down.
 *   • L-R mirror:    θ → (180° − θ)
 *   • U-D mirror:    θ → (360° − θ)
 *   • 180° rotation: θ → (180° + θ)
 *
 * This removes random quadrant-level lopsidedness from rectangular screens,
 * fixation offsets, and sparse meridian sampling while still preserving
 * cardinal-axis differences (e.g. inferior altitudinal defects, asymmetric
 * superior/inferior loss). The clinical VisualFieldMap keeps the unmodified
 * directional geometry.
 *
 * Second stage — full radial averaging — flattens cardinal differences on
 * top of the 4-fold fix. This is essential when the outer isopters (V4e /
 * III4e) are screen-limited along the short screen axis: the raw data
 * shows a wide horizontal peanut (reaching to ~60° left/right, only ~15°
 * up/down) purely because the test hit the vertical screen edges. In
 * normalized-radius space that peanut gives huge gap fractions along the
 * horizontal and negligible gaps along the vertical, so getVisionQuality
 * emits a ring scotoma band at horizontal meridians but none at vertical —
 * producing an X-shaped alternating clear/scotoma pattern that doesn't
 * represent the patient's actual subjective experience. Averaging each
 * isopter to a single mean radius preserves inter-isopter gaps (the real
 * signal) while killing the angle-dependent asymmetry that's an artefact
 * of screen shape.
 */
function circularizeBoundary(points: BoundaryPoint[]): BoundaryPoint[] {
  const n = points.length
  if (n < 2) return points

  // Stage 1: full radial mean. The simulator is a radial approximation
  // anyway, and per-angle asymmetry from screen clipping produces worse
  // artefacts than a flat circle would.
  let sum = 0
  for (const p of points) sum += p.normalizedRadius
  const meanRadius = sum / n
  const result: BoundaryPoint[] = new Array(n)
  for (let i = 0; i < n; i++) {
    result[i] = { angleDeg: points[i].angleDeg, normalizedRadius: meanRadius }
  }
  return result
}

/**
 * Fast radius lookup for a resampled boundary (1° resolution = direct index).
 */
function lookupRadius(boundary: BoundaryPoint[], angleDeg: number): number {
  if (boundary.length === 0) return 1
  if (boundary.length < 360) {
    // Fallback for sparse boundaries — linear interpolation
    return interpolateRadiusLinear(boundary, angleDeg)
  }
  const a = ((angleDeg % 360) + 360) % 360
  const idx = Math.floor(a) % boundary.length
  const frac = a - Math.floor(a)
  const next = (idx + 1) % boundary.length
  return boundary[idx].normalizedRadius * (1 - frac) + boundary[next].normalizedRadius * frac
}

function interpolateRadiusLinear(boundary: BoundaryPoint[], angleDeg: number): number {
  if (boundary.length === 0) return 1
  if (boundary.length === 1) return boundary[0].normalizedRadius
  const a = ((angleDeg % 360) + 360) % 360
  let lower = boundary[boundary.length - 1]
  let upper = boundary[0]
  for (let i = 0; i < boundary.length; i++) {
    if (boundary[i].angleDeg >= a) {
      upper = boundary[i]
      lower = boundary[(i - 1 + boundary.length) % boundary.length]
      break
    }
    if (i === boundary.length - 1) {
      lower = boundary[i]
      upper = boundary[0]
    }
  }
  const lowerAngle = lower.angleDeg
  let upperAngle = upper.angleDeg
  let targetAngle = a
  if (upperAngle <= lowerAngle) upperAngle += 360
  if (targetAngle < lowerAngle) targetAngle += 360
  const range = upperAngle - lowerAngle
  if (range === 0) return lower.normalizedRadius
  const t = (targetAngle - lowerAngle) / range
  return lower.normalizedRadius + t * (upper.normalizedRadius - lower.normalizedRadius)
}

/**
 * Compute continuous vision quality for a pixel (0 = blind, 1 = perfect).
 *
 * Model: being inside the outermost boundary (V4e) = functional vision (0.90).
 * Each additional inner boundary adds a small detail bonus (+0.025 each, up to +0.10).
 *
 * Ring scotoma: when a large gap exists between consecutive isopter boundaries,
 * a smooth bell-curve scotoma is applied — deepest at the gap center, smoothly
 * fading toward both the inner (central) and outer (peripheral) edges. Beyond
 * the outermost boundary, vision continues to recover smoothly.
 *
 * Normal bypass: if the outermost boundary extends beyond the visible image
 * (>1.05 normalized), return 1.0 — no overlay needed.
 */
function getVisionQuality(
  dist: number,
  angleDeg: number,
  boundaries: IsopterBoundary[],
): number {
  if (boundaries.length === 0) return 0

  const EDGE_WIDTH = 0.06

  // Get boundary radii sorted by stimulus order (V4e first → I2e last)
  const orderedBounds = boundaries
    .map(b => ({ orderIdx: b.orderIdx, radius: lookupRadius(b.points, angleDeg) }))
    .sort((a, b) => a.orderIdx - b.orderIdx)

  const outermostRadius = Math.max(...orderedBounds.map(b => b.radius))

  // ── Normal bypass ──
  if (outermostRadius > 1.05) return 1.0

  // ── Ring scotoma detection (all gaps above threshold) ──
  // Find every gap between consecutive isopters wider than the threshold —
  // double-ring patterns (two scotoma bands) need all of them applied, not just
  // the largest one.
  const RING_GAP_THRESHOLD = 0.25
  const gaps: { center: number; halfWidth: number }[] = []
  for (let i = 0; i < orderedBounds.length - 1; i++) {
    const outerR = orderedBounds[i].radius
    const innerR = orderedBounds[i + 1].radius
    const gap = outerR - innerR
    if (gap > RING_GAP_THRESHOLD) {
      gaps.push({ center: (outerR + innerR) / 2, halfWidth: gap / 2 })
    }
  }

  // ── Ring scotoma path ──
  if (gaps.length > 0) {
    // Vision is fully clear everywhere EXCEPT the scotoma bands. Combine multiple
    // bands by taking the deepest penalty (each band is independent).
    let quality = 1.0

    for (const g of gaps) {
      const distFromCenter = Math.abs(dist - g.center) / g.halfWidth
      let bandQuality = 1.0
      if (distFromCenter < 1.0) {
        // Inside this scotoma band — smooth bell-curve penalty
        const t = 1 - distFromCenter
        const bellCurve = t * t * (3 - 2 * t)
        const maxPenalty = Math.min(0.85, 0.50 + g.halfWidth * 1.5)
        bandQuality = 1 - bellCurve * maxPenalty
      } else if (distFromCenter < 1.5) {
        // Narrow transition zone — smooth falloff back to clear
        const overshoot = (distFromCenter - 1.0) / 0.5
        const smoothFalloff = overshoot * overshoot * (3 - 2 * overshoot)
        bandQuality = 1 - (1 - smoothFalloff) * 0.05
      }
      // Combine: deepest penalty wins
      if (bandQuality < quality) quality = bandQuality
    }

    return Math.min(1, Math.max(0, quality))
  }

  // ── Standard (non-ring) field loss ──

  // Beyond outermost boundary → absolute scotoma
  if (dist > outermostRadius + EDGE_WIDTH) {
    return 0
  }

  // Inside the outermost boundary: functional vision
  let quality = 0.90

  // Detail bonus for each inner boundary the pixel is inside (+0.025 each)
  for (const b of orderedBounds) {
    if (dist < b.radius - EDGE_WIDTH) {
      quality += 0.025
    } else if (dist < b.radius + EDGE_WIDTH) {
      const t = (dist - (b.radius - EDGE_WIDTH)) / (2 * EDGE_WIDTH)
      quality += 0.025 * (1 - t * t * (3 - 2 * t))
    }
  }
  quality = Math.min(1.0, quality)

  // Edge transition at outermost boundary
  if (dist > outermostRadius - EDGE_WIDTH) {
    const t = (dist - (outermostRadius - EDGE_WIDTH)) / (2 * EDGE_WIDTH)
    quality *= 1 - t * t * (3 - 2 * t)
  }

  return Math.min(1, quality)
}

/**
 * Pre-compute a quality map for the given dimensions and boundaries.
 * Returns a Float32Array where each value is the vision quality (0–1) for that pixel.
 */
function buildQualityMap(
  w: number,
  h: number,
  boundaries: IsopterBoundary[],
): Float32Array {
  const map = new Float32Array(w * h)
  const cx = w / 2
  const cy = h / 2

  // Circular normalization: 1.0 = half the shorter dimension.
  // This keeps the scotoma pattern round (natural for RP).
  const maxR = Math.min(w, h) / 2

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const dx = px - cx
      const dy = -(py - cy)
      const dist = Math.sqrt(dx * dx + dy * dy) / maxR
      let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI
      if (angleDeg < 0) angleDeg += 360

      map[py * w + px] = getVisionQuality(dist, angleDeg, boundaries)
    }
  }
  return map
}

// ---- Visual effect types common in RP ----
type VisualEffect = 'photopsia' | 'coronas' | 'snow' | 'phosphenes' | 'floaters'
const EFFECT_INFO: Record<VisualEffect, { label: string; desc: string; prevalence: string }> = {
  photopsia: {
    label: 'Plasma waves',
    desc: 'Rolling electric waves sweeping across scotoma',
    prevalence: '93% of RP patients',
  },
  coronas: {
    label: 'Corona flashes',
    desc: 'Static flashing orbs with bright edges in scotoma',
    prevalence: '93% of RP patients',
  },
  snow: {
    label: 'Visual snow',
    desc: 'TV-static noise across the visual field',
    prevalence: '~22% of RP patients',
  },
  phosphenes: {
    label: 'Phosphenes',
    desc: 'Soft glowing blobs drifting in blind areas',
    prevalence: 'Common in retinal degeneration',
  },
  floaters: {
    label: 'Floaters',
    desc: 'Dark drifting shapes from vitreous changes',
    prevalence: 'Common in RP',
  },
}

export function VisionSimulator({ points, eye, maxEccentricity, secondEyePoints, secondEyeMaxEccentricity }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [sceneUrl, setSceneUrl] = useState(DEFAULT_SCENE_URL)
  const [customImage, setCustomImage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showBoth, setShowBoth] = useState(false)
  const [darkness, setDarkness] = useState(0.75)
  const [blurAmount, setBlurAmount] = useState(1.0)
  const [cameraActive, setCameraActive] = useState(false)
  // Maps effect → intensity 0–1 (0 = off, default when toggled on = 0.5)
  const [effectIntensities, setEffectIntensities] = useState<Partial<Record<VisualEffect, number>>>({})
  const [showEffectsPanel, setShowEffectsPanel] = useState(false)
  // Derived active set for convenience
  const activeEffects = new Set(
    (Object.keys(effectIntensities) as VisualEffect[]).filter(k => (effectIntensities[k] ?? 0) > 0),
  )
  const [expanded, setExpanded] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafIdRef = useRef(0)
  const effectRafRef = useRef(0)

  const activeUrl = customImage ?? sceneUrl

  const toggleEffect = (e: VisualEffect) => {
    setEffectIntensities(prev => {
      const next = { ...prev }
      if ((next[e] ?? 0) > 0) delete next[e]
      else next[e] = 0.5 // default intensity
      return next
    })
  }
  const setEffectIntensity = (e: VisualEffect, val: number) => {
    setEffectIntensities(prev => ({ ...prev, [e]: val }))
  }

  // Build tagged boundaries for primary eye
  const boundaries = buildTaggedBoundaries(points, maxEccentricity)
  const secondBoundaries = secondEyePoints
    ? buildTaggedBoundaries(
        secondEyePoints.map(p => ({
          ...p,
          meridianDeg: (360 - p.meridianDeg) % 360,
        })),
        secondEyeMaxEccentricity ?? maxEccentricity,
      )
    : []
  const allBoundaries = [...boundaries, ...secondBoundaries]

  const renderCanvas = useCallback(
    (img: HTMLImageElement, darknessLevel: number, blurLevel: number = 0.5) => {
      const canvas = canvasRef.current
      if (!canvas) return

      const w = img.naturalWidth || 800
      const h = img.naturalHeight || 600
      canvas.width = w
      canvas.height = h

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      if (showBoth) {
        const halfW = Math.floor(w / 2)
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, 0, halfW, h)
        ctx.clip()
        ctx.drawImage(img, 0, 0, w, h)
        ctx.restore()

        ctx.save()
        ctx.beginPath()
        ctx.rect(halfW, 0, w - halfW, h)
        ctx.clip()
        ctx.drawImage(img, 0, 0, w, h)
        ctx.restore()
        applyFieldLoss(ctx, img, w, h, allBoundaries, halfW, w, darknessLevel, blurLevel)

        ctx.strokeStyle = 'white'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(halfW, 0)
        ctx.lineTo(halfW, h)
        ctx.stroke()

        ctx.fillStyle = 'rgba(0,0,0,0.6)'
        ctx.fillRect(halfW - 70, h - 30, 60, 22)
        ctx.fillRect(halfW + 10, h - 30, 80, 22)
        ctx.fillStyle = 'white'
        ctx.font = '13px Inter, sans-serif'
        ctx.fillText('Normal', halfW - 64, h - 14)
        ctx.fillText('With RP', halfW + 16, h - 14)
      } else {
        ctx.drawImage(img, 0, 0, w, h)
        applyFieldLoss(ctx, img, w, h, allBoundaries, 0, w, darknessLevel, blurLevel)
      }

      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '11px Inter, sans-serif'
      const eyeLabel = secondEyePoints ? 'OU (both eyes)' : formatEyeLabelForResult(eye)
      ctx.fillText(`${APP_NAME} — ${eyeLabel} — simulated`, 8, h - 8)
    },
    [allBoundaries, eye, showBoth, secondEyePoints],
  )

  useEffect(() => {
    if (cameraActive) return // camera owns the canvas — don't touch it
    setLoading(true)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      renderCanvas(img, darkness, blurAmount)
      setLoading(false)
    }
    img.onerror = () => setLoading(false)
    img.src = activeUrl
  }, [activeUrl, renderCanvas, darkness, blurAmount, cameraActive])

  const handleDarknessChange = (val: number) => {
    setDarkness(val)
    if (cameraActive) return
    if (imgRef.current) {
      renderCanvas(imgRef.current, val, blurAmount)
    }
  }

  const handleBlurChange = (val: number) => {
    setBlurAmount(val)
    if (cameraActive) return
    if (imgRef.current) {
      renderCanvas(imgRef.current, darkness, val)
    }
  }

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setCustomImage(reader.result as string)
    reader.readAsDataURL(file)
  }

  // ---------- Live camera (POV mode) ----------
  const darknessRef = useRef(darkness)
  darknessRef.current = darkness
  const blurAmountRef = useRef(blurAmount)
  blurAmountRef.current = blurAmount
  const boundariesRef = useRef(allBoundaries)
  boundariesRef.current = allBoundaries

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafIdRef.current)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
      videoRef.current = null
    }
    setCameraActive(false)
    // Re-render the static image so canvas isn't left blank
    requestAnimationFrame(() => {
      if (imgRef.current) {
        renderCanvas(imgRef.current, darknessRef.current, blurAmountRef.current)
      }
    })
  }, [renderCanvas])

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
      })
      streamRef.current = stream

      const video = document.createElement('video')
      video.srcObject = stream
      video.playsInline = true
      video.muted = true
      await video.play()
      videoRef.current = video

      setCameraActive(true)

      const canvas = canvasRef.current
      if (!canvas) return

      // Wait for video dimensions
      await new Promise<void>(resolve => {
        const check = () => {
          if (video.videoWidth > 0) resolve()
          else requestAnimationFrame(check)
        }
        check()
      })

      const vw = video.videoWidth
      const vh = video.videoHeight
      // Work at moderate resolution for balance of quality & performance
      const scale = Math.min(1, 640 / vh)
      const w = Math.round(vw * scale)
      const h = Math.round(vh * scale)
      canvas.width = w
      canvas.height = h

      // Pre-compute quality map once
      const qualityMap = buildQualityMap(w, h, boundariesRef.current)

      // Pre-compute blurred frame canvases (reusable offscreen canvases)
      const blurCanvases = BLUR_SCALES.map(s => {
        const c = document.createElement('canvas')
        const sw = Math.max(2, Math.round(w * s))
        const sh = Math.max(2, Math.round(h * s))
        c.width = sw
        c.height = sh
        return { canvas: c, sw, sh, scale: s }
      })
      const fullBlur = document.createElement('canvas')
      fullBlur.width = w
      fullBlur.height = h

      const renderFrame = () => {
        if (!videoRef.current || !canvasRef.current) return
        const ctx = canvasRef.current.getContext('2d')
        if (!ctx) return

        // Draw current video frame
        ctx.drawImage(video, 0, 0, w, h)

        // Create blurred versions of this frame
        const blurredData: ImageData[] = []
        for (let i = 0; i < blurCanvases.length; i++) {
          if (blurCanvases[i].scale >= 1.0) {
            blurredData.push(ctx.getImageData(0, 0, w, h))
          } else {
            const { canvas: sc, sw, sh } = blurCanvases[i]
            const sCtx = sc.getContext('2d')!
            sCtx.imageSmoothingEnabled = true
            sCtx.imageSmoothingQuality = 'high'
            sCtx.drawImage(video, 0, 0, sw, sh)

            // Extra downscale pass for extreme blur
            if (blurCanvases[i].scale < 0.05) {
              const tw = Math.max(2, Math.round(sw * 0.5))
              const th = Math.max(2, Math.round(sh * 0.5))
              const tiny = document.createElement('canvas')
              tiny.width = tw
              tiny.height = th
              const tCtx = tiny.getContext('2d')!
              tCtx.imageSmoothingEnabled = true
              tCtx.imageSmoothingQuality = 'high'
              tCtx.drawImage(sc, 0, 0, tw, th)
              sCtx.clearRect(0, 0, sw, sh)
              sCtx.drawImage(tiny, 0, 0, sw, sh)
            }

            const fCtx = fullBlur.getContext('2d')!
            fCtx.imageSmoothingEnabled = true
            fCtx.imageSmoothingQuality = 'high'
            fCtx.drawImage(sc, 0, 0, w, h)
            blurredData.push(fCtx.getImageData(0, 0, w, h))
          }
        }

        // Apply field loss using pre-computed quality map
        const imageData = ctx.getImageData(0, 0, w, h)
        const outData = imageData.data
        const dk = darknessRef.current
        const bl = blurAmountRef.current

        for (let py = 0; py < h; py++) {
          for (let px = 0; px < w; px++) {
            const quality = qualityMap[py * w + px]
            if (quality >= 0.99) continue

            const idx = (py * w + px) * 4
            const rawBlurT = (1 - quality) * (BLUR_SCALES.length - 1) * bl
            const blurT = Math.min(rawBlurT, BLUR_SCALES.length - 1 - 0.01)
            const blurIdx = Math.min(Math.floor(blurT), BLUR_SCALES.length - 2)
            const blurFrac = blurT - blurIdx

            const d1 = blurredData[blurIdx].data
            const d2 = blurredData[blurIdx + 1].data
            const r = d1[idx] * (1 - blurFrac) + d2[idx] * blurFrac
            const g = d1[idx + 1] * (1 - blurFrac) + d2[idx + 1] * blurFrac
            const b = d1[idx + 2] * (1 - blurFrac) + d2[idx + 2] * blurFrac

            const keep = 1 - (1 - quality) * dk * 0.95
            outData[idx] = Math.round(r * keep)
            outData[idx + 1] = Math.round(g * keep)
            outData[idx + 2] = Math.round(b * keep)
          }
        }

        ctx.putImageData(imageData, 0, 0)

        rafIdRef.current = requestAnimationFrame(renderFrame)
      }

      rafIdRef.current = requestAnimationFrame(renderFrame)
    } catch (err) {
      console.error('Camera access failed:', err)
      setCameraActive(false)
    }
  }, [])

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafIdRef.current)
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
    }
  }, [])

  // ---- Animated visual effects overlay ----
  const activeEffectsRef = useRef(activeEffects)
  activeEffectsRef.current = activeEffects
  const intensitiesRef = useRef(effectIntensities)
  intensitiesRef.current = effectIntensities

  // Persistent state for animated effects
  const floaterStateRef = useRef<{ x: number; y: number; vx: number; vy: number; size: number; opacity: number; shape: number[] }[]>([])
  const phospheneStateRef = useRef<{ x: number; y: number; r: number; phase: number; speed: number; drift: number }[]>([])
  // Static corona orbs in the scotoma (sun-like flashing balls with bright edges)
  const coronaOrbsRef = useRef<{
    angleDeg: number      // fixed position on scotoma ring
    radialPos: number     // 0=inner, 1=outer within scotoma band
    size: number          // radius in px
    phase: number         // flicker phase
    flickerSpeed: number  // how fast it flickers
    brightness: number    // base brightness
  }[]>([])

  // Plasma wave state: each wave rolls around the scotoma border
  const photopsiaStateRef = useRef<{
    angle: number        // current center angle (degrees, moves over time)
    speed: number        // angular speed (deg/sec)
    spread: number       // angular width of the wave (degrees)
    bandWidth: number    // radial thickness of the plasma band (normalized)
    life: number
    maxLife: number
    brightness: number
    // Per-tendril offsets for organic plasma look (seeded once)
    tendrils: { offset: number; freq: number; amp: number; phase: number }[]
  }[]>([])

  useEffect(() => {
    if (activeEffects.size === 0) {
      // Clear overlay
      const oc = overlayRef.current
      if (oc) {
        const ctx = oc.getContext('2d')
        if (ctx) ctx.clearRect(0, 0, oc.width, oc.height)
      }
      cancelAnimationFrame(effectRafRef.current)
      return
    }

    // Initialize corona orbs if needed
    if (activeEffects.has('coronas') && coronaOrbsRef.current.length === 0) {
      const ci = effectIntensities.coronas ?? 0.5
      const count = Math.round(20 + ci * 80) // 20–100 orbs based on intensity
      coronaOrbsRef.current = Array.from({ length: count }, () => ({
        angleDeg: Math.random() * 360,
        radialPos: Math.random(),
        size: 2 + Math.random() * 10,
        phase: Math.random() * Math.PI * 2,
        flickerSpeed: 3 + Math.random() * 10, // fast flicker
        brightness: 0.3 + Math.random() * 0.7,
      }))
    }
    // Re-generate orbs when coronas turned off then back on
    if (!activeEffects.has('coronas') && coronaOrbsRef.current.length > 0) {
      coronaOrbsRef.current = []
    }

    // Initialize floaters if needed
    if (activeEffects.has('floaters') && floaterStateRef.current.length === 0) {
      floaterStateRef.current = Array.from({ length: 6 }, () => ({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.0003,
        vy: 0.0002 + Math.random() * 0.0004,
        size: 8 + Math.random() * 25,
        opacity: 0.08 + Math.random() * 0.12,
        shape: Array.from({ length: 8 }, () => 0.5 + Math.random() * 0.5),
      }))
    }

    // Initialize phosphenes if needed — position in scotoma regions
    if (activeEffects.has('phosphenes') && phospheneStateRef.current.length === 0) {
      // Find scotoma positions by sampling boundaries
      const phBounds = buildTaggedBoundaries(points, maxEccentricity)
      const phosPositions: { x: number; y: number }[] = []
      for (let attempt = 0; attempt < 50 && phosPositions.length < 5; attempt++) {
        const angle = Math.random() * 360
        const rad = (angle * Math.PI) / 180
        // Sample along this angle to find low-quality region
        for (let d = 0.1; d < 1.3; d += 0.05) {
          const q = getVisionQuality(d, angle, phBounds)
          if (q < 0.4) {
            // Found scotoma — place phosphene here
            const nx = 0.5 + d * Math.cos(rad) * 0.4  // map to 0–1 canvas coords
            const ny = 0.5 - d * Math.sin(rad) * 0.4
            phosPositions.push({ x: nx, y: ny })
            break
          }
        }
      }
      // Fallback if no scotoma found
      if (phosPositions.length === 0) {
        for (let i = 0; i < 5; i++) {
          phosPositions.push({ x: 0.3 + Math.random() * 0.4, y: 0.3 + Math.random() * 0.4 })
        }
      }
      phospheneStateRef.current = phosPositions.map(pos => ({
        x: pos.x,
        y: pos.y,
        r: 30 + Math.random() * 60,
        phase: Math.random() * Math.PI * 2,
        speed: 0.3 + Math.random() * 0.5,
        drift: Math.random() * Math.PI * 2,
      }))
    }

    let lastTime = performance.now()

    const renderEffects = (time: number) => {
      const dt = (time - lastTime) / 1000
      lastTime = time

      const oc = overlayRef.current
      const mc = canvasRef.current
      if (!oc || !mc) { effectRafRef.current = requestAnimationFrame(renderEffects); return }

      // Match overlay size to main canvas
      if (oc.width !== mc.width || oc.height !== mc.height) {
        oc.width = mc.width
        oc.height = mc.height
      }

      const ctx = oc.getContext('2d')!
      const w = oc.width
      const h = oc.height
      const cx = w / 2
      const cy = h / 2
      const maxR = Math.min(w, h) / 2
      const effects = activeEffectsRef.current
      const bounds = boundariesRef.current
      const intensities = intensitiesRef.current

      ctx.clearRect(0, 0, w, h)

      // ── Scotoma-aware helpers ──
      // Instead of using inner/outer boundary positions (which don't capture
      // ring scotomas), sample actual vision quality along radial lines to find
      // where scotoma regions are. Effects should render IN the scotoma.

      // Pre-compute scotoma band at each degree (cached for the frame)
      // Returns { scotomaStart, scotomaEnd, scotomaCenter } in normalized radius
      // For tunnel vision: scotoma starts at outer boundary, extends to edge
      // For ring scotoma: scotoma is the mid-peripheral band between inner and outer isopters
      const QUALITY_THRESHOLD = 0.4 // below this = scotoma
      const scotomaCache = new Map<number, { start: number; end: number; center: number }>()

      const getScotomaBand = (angleDeg: number) => {
        const key = Math.round(angleDeg) % 360
        if (scotomaCache.has(key)) return scotomaCache.get(key)!

        // Sample quality along this radial line from center to edge
        const SAMPLES = 50
        let scotomaStart = -1
        let scotomaEnd = -1

        for (let i = 0; i <= SAMPLES; i++) {
          const dist = i / SAMPLES * 1.4 // sample up to 1.4× normalized
          const q = getVisionQuality(dist, angleDeg, bounds)
          if (q < QUALITY_THRESHOLD) {
            if (scotomaStart < 0) scotomaStart = dist
            scotomaEnd = dist
          }
        }

        // No scotoma found — place effects at a default ring
        if (scotomaStart < 0) {
          const result = { start: 0.5, end: 0.8, center: 0.65 }
          scotomaCache.set(key, result)
          return result
        }

        const result = {
          start: scotomaStart,
          end: scotomaEnd,
          center: (scotomaStart + scotomaEnd) / 2,
        }
        scotomaCache.set(key, result)
        return result
      }

      // Legacy-compatible helper that maps to scotoma band
      const getBorderR = (angleDeg: number) => {
        const band = getScotomaBand(angleDeg)
        return { outer: band.end, inner: band.start }
      }

      // ---- Visual snow ----
      if (effects.has('snow')) {
        const si = intensities.snow ?? 0.5 // 0–1 intensity
        const densityMul = 0.3 + si * 1.4 // 0.3× at min, 1.7× at max
        const alphaMul = 0.5 + si * 1.0 // 0.5× at min, 1.5× at max
        const snowData = ctx.createImageData(w, h)
        const sd = snowData.data
        for (let i = 0; i < w * h; i++) {
          if (Math.random() > 0.08 * densityMul) continue
          const px = i % w
          const py = Math.floor(i / w)
          const dx = px - cx
          const dy = -(py - cy)
          const dist = Math.sqrt(dx * dx + dy * dy) / maxR
          let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI
          if (angleDeg < 0) angleDeg += 360
          const q = bounds.length > 0 ? getVisionQuality(dist, angleDeg, bounds) : 0.5

          // More snow in scotoma, some everywhere
          const zoneIntensity = q < 0.3 ? 0.20 : q < 0.7 ? 0.10 : 0.04
          if (Math.random() > (zoneIntensity * densityMul) / (0.04 * densityMul + 0.01)) continue

          const idx = i * 4
          const v = Math.random() > 0.5 ? 180 + Math.random() * 75 : Math.random() * 60
          sd[idx] = v
          sd[idx + 1] = v
          sd[idx + 2] = v
          sd[idx + 3] = Math.round((25 + Math.random() * 30) * alphaMul)
        }
        ctx.putImageData(snowData, 0, 0)
      }

      // ---- Phosphenes (soft glowing blobs in scotoma) ----
      if (effects.has('phosphenes')) {
        const pi = intensities.phosphenes ?? 0.5
        const phos = phospheneStateRef.current
        for (const p of phos) {
          p.phase += dt * p.speed
          p.x += Math.cos(p.drift) * dt * 0.008
          p.y += Math.sin(p.drift) * dt * 0.006
          p.drift += (Math.random() - 0.5) * dt * 0.5
          // Keep within canvas bounds
          if (p.x < 0.05 || p.x > 0.95) p.x = 0.5 + (Math.random() - 0.5) * 0.6
          if (p.y < 0.05 || p.y > 0.95) p.y = 0.5 + (Math.random() - 0.5) * 0.6

          const px = p.x * w
          const py = p.y * h
          const dx = px - cx
          const dy = -(py - cy)
          const dist = Math.sqrt(dx * dx + dy * dy) / maxR
          let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI
          if (angleDeg < 0) angleDeg += 360
          const q = bounds.length > 0 ? getVisionQuality(dist, angleDeg, bounds) : 0.5

          // Only show in low-quality (scotoma) regions — scaled by intensity
          const baseAlpha = q < 0.4 ? 0.06 + 0.04 * Math.sin(p.phase) : 0
          const alpha = baseAlpha * (0.4 + pi * 1.6) // 0.4× at min, 2× at max
          if (alpha <= 0) continue

          const scaledR = p.r * (0.7 + pi * 0.6) // blobs grow with intensity
          const grad = ctx.createRadialGradient(px, py, 0, px, py, scaledR)
          const hue = 180 + Math.sin(p.phase * 0.3) * 40 // blue-green shift
          grad.addColorStop(0, `hsla(${hue}, 30%, 70%, ${alpha})`)
          grad.addColorStop(0.6, `hsla(${hue}, 20%, 50%, ${alpha * 0.3})`)
          grad.addColorStop(1, `hsla(${hue}, 10%, 30%, 0)`)
          ctx.fillStyle = grad
          ctx.fillRect(px - p.r, py - p.r, p.r * 2, p.r * 2)
        }
      }

      // ---- Photopsias (horizontal plasma waves sweeping across scotoma) ----
      // Waves sweep LEFT↔RIGHT across the scotoma ring like plasma globe
      // discharges. Bright white, high contrast, no gray shadow haze.
      if (effects.has('photopsia')) {
        const phi = intensities.photopsia ?? 0.5
        const maxWaves = Math.round(1 + phi * 3)
        const spawnRate = 0.2 + phi * 0.5
        const phots = photopsiaStateRef.current

        // Spawn new horizontal waves
        if (phots.length < maxWaves && Math.random() < dt * spawnRate) {
          const numTendrils = 3 + Math.floor(phi * 5)
          phots.push({
            angle: 0, // used as horizontal position: -1 (left) to +1 (right)
            speed: (0.3 + Math.random() * 0.5) * (Math.random() < 0.5 ? 1 : -1),
            spread: 30 + Math.random() * 20 + phi * 15, // narrower angular coverage
            bandWidth: 0.04 + Math.random() * 0.04 + phi * 0.03, // thinner radial band
            life: 0,
            maxLife: 2.5 + Math.random() * 4,
            brightness: 0.7 + Math.random() * 0.3,
            tendrils: Array.from({ length: numTendrils }, () => ({
              offset: (Math.random() - 0.5) * 0.6,
              freq: 2 + Math.random() * 4,
              amp: 0.015 + Math.random() * 0.035, // tighter oscillation
              phase: Math.random() * Math.PI * 2,
            })),
          })
        }


        // Get scotoma midline radius at an angle (center of the scotoma band)
        const getScotomaCenter = (angleDeg: number) => {
          const { outer, inner } = getBorderR(angleDeg)
          return (outer + inner) / 2
        }

        for (let i = phots.length - 1; i >= 0; i--) {
          const p = phots[i]
          p.life += dt
          if (p.life > p.maxLife) { phots.splice(i, 1); continue }

          // Horizontal sweep: p.angle stores normalized x position (-1.5 to 1.5)
          p.angle += p.speed * dt
          // Wrap around
          if (p.angle > 1.8) p.angle = -1.8
          if (p.angle < -1.8) p.angle = 1.8

          const progress = p.life / p.maxLife
          const fadeIn = Math.min(1, progress * 4)
          const fadeOut = Math.max(0, 1 - (progress - 0.7) / 0.3)
          const envelope = fadeIn * fadeOut * p.brightness

          // The wave front is a vertical band at horizontal position p.angle
          // It intersects the scotoma ring at various points.
          // We render it by sampling angles around the ring and only drawing
          // where the horizontal position of the scotoma matches the wave position.
          const waveX = p.angle // normalized horizontal position (-1.5 to 1.5)
          const waveHalfWidth = 0.08 + phi * 0.06 // narrower wave front

          // --- Layer 1: Bright plasma tendrils ---
          for (const tendril of p.tendrils) {
            ctx.beginPath()
            let started = false
            let segmentStarted = false

            // Sample around the full 360° ring
            for (let deg = 0; deg < 360; deg += 1) {
              const angleDeg = deg
              const scotomaR = getScotomaCenter(angleDeg)
              const rad = (-angleDeg * Math.PI) / 180

              // Horizontal position of this point on the scotoma ring
              const pointX = scotomaR * Math.cos(rad)

              // How close is this point to the wave front?
              const distToWave = Math.abs(pointX - waveX)
              if (distToWave > waveHalfWidth * 1.5) {
                segmentStarted = false
                continue
              }

              // Intensity based on proximity to wave center
              const waveFalloff = 1 - Math.min(1, distToWave / waveHalfWidth)

              // Tendril oscillation
              const wavePhase = tendril.phase + p.life * tendril.freq * Math.PI * 2
              const radialOffset = Math.sin(wavePhase + deg * 0.15) * tendril.amp
                + Math.sin(wavePhase * 1.7 + deg * 0.25) * tendril.amp * 0.6
              const r = (scotomaR + radialOffset + tendril.offset * p.bandWidth) * maxR

              const px2 = cx + r * Math.cos(rad)
              const py2 = cy + r * Math.sin(rad)

              if (!segmentStarted) {
                if (started) {
                  // Draw previous segment
                  const flicker = 0.5 + Math.random() * 0.5
                  const a = envelope * (0.4 + phi * 0.6) * flicker * waveFalloff
                  ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1, a)})`
                  ctx.lineWidth = 1.5 + phi * 2 + Math.random() * 1.5
                  ctx.stroke()
                  ctx.beginPath()
                }
                ctx.moveTo(px2, py2)
                segmentStarted = true
                started = true
              } else {
                ctx.lineTo(px2, py2)
              }
            }

            // Draw final segment
            if (segmentStarted) {
              const flicker = 0.5 + Math.random() * 0.5
              const a = envelope * (0.5 + phi * 0.5) * flicker
              ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1, a)})`
              ctx.lineWidth = 1.5 + phi * 2 + Math.random() * 1.5
              ctx.stroke()
            }
          }

          // --- Layer 2: Bright flash core ---
          // A thick bright white stroke at the scotoma boundary where the wave is
          for (let deg = 0; deg < 360; deg += 2) {
            const angleDeg = deg
            const { outer, inner } = getBorderR(angleDeg)
            const scotomaR = (outer + inner) / 2
            const rad = (-angleDeg * Math.PI) / 180
            const pointX = scotomaR * Math.cos(rad)
            const distToWave = Math.abs(pointX - waveX)

            if (distToWave < waveHalfWidth) {
              const waveFalloff = 1 - distToWave / waveHalfWidth
              const flashAlpha = envelope * waveFalloff * waveFalloff * (0.5 + phi * 0.5)
              const flashR = scotomaR * maxR
              const bandH = (outer - inner) * maxR * (0.3 + phi * 0.2)
              const px2 = cx + flashR * Math.cos(rad)
              const py2 = cy + flashR * Math.sin(rad)

              ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, flashAlpha)})`
              ctx.beginPath()
              ctx.arc(px2, py2, bandH * 0.3 + 0.5, 0, Math.PI * 2)
              ctx.fill()
            }
          }

          // --- Layer 3: Rapid sparkle discharge along wave front ---
          const sparkCount = Math.round((10 + phi * 100) * envelope)
          for (let s = 0; s < sparkCount; s++) {
            const angleDeg = Math.random() * 360
            const { outer, inner } = getBorderR(angleDeg)
            const scotomaR = inner + Math.random() * (outer - inner)
            const rad = (-angleDeg * Math.PI) / 180
            const pointX = scotomaR * Math.cos(rad)
            const distToWave = Math.abs(pointX - waveX)

            // Sparkles concentrated near wave front but some scattered wider
            const maxDist = waveHalfWidth * (1.5 + phi)
            if (distToWave > maxDist) continue

            const proximity = 1 - distToWave / maxDist
            const r = scotomaR * maxR + (Math.random() - 0.5) * p.bandWidth * maxR
            const sx = cx + r * Math.cos(rad)
            const sy = cy + r * Math.sin(rad)

            const sparkAlpha = proximity * (0.5 + Math.random() * 0.5) * envelope * (0.5 + phi * 0.5)
            const sparkSize = 1 + Math.random() * (2 + phi * 2)

            ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, sparkAlpha)})`
            ctx.fillRect(sx - sparkSize / 2, sy - sparkSize / 2, sparkSize, sparkSize)
          }
        }

        // --- Ambient border sparkles (subtle background crackle, only at high intensity) ---
        if (phi > 0.6) {
          const ambientCount = Math.round((phi - 0.6) * 60) // 0–24 max, very sparse
          for (let s = 0; s < ambientCount; s++) {
            const angleDeg = Math.random() * 360
            const { outer, inner } = getBorderR(angleDeg)
            const scotomaR = inner + Math.random() * (outer - inner)
            const rad = (-angleDeg * Math.PI) / 180
            const r = scotomaR * maxR

            const sx = cx + r * Math.cos(rad)
            const sy = cy + r * Math.sin(rad)

            const sparkAlpha = (0.15 + Math.random() * 0.25) * (phi - 0.6) * 2.5
            ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, sparkAlpha)})`
            ctx.fillRect(sx - 0.5, sy - 0.5, 1.5, 1.5)
          }
        }

        photopsiaStateRef.current = phots
      }

      // ---- Corona flashes (static flashing orbs in scotoma) ----
      // Sun-like balls with bright edges scattered through the scotoma ring.
      // Blue-white, limb brightening (edges brighter than center).
      if (effects.has('coronas')) {
        const ci = intensities.coronas ?? 0.5
        const orbs = coronaOrbsRef.current
        for (const orb of orbs) {
          orb.phase += dt * orb.flickerSpeed

          // Rapid binary-ish flicker (overlapping harmonics = choppy on/off)
          const flickerRaw = Math.sin(orb.phase) + Math.sin(orb.phase * 2.3) * 0.5 + Math.sin(orb.phase * 5.7) * 0.3
          const flicker = Math.max(0, flickerRaw / 1.8)
          if (flicker < 0.1) continue // dark phase

          const alpha = flicker * orb.brightness * (0.3 + ci * 0.7)

          // Position: map orb to scotoma ring
          const { outer, inner } = getBorderR(orb.angleDeg)
          const scotomaR = inner + orb.radialPos * (outer - inner)
          const rad = (-orb.angleDeg * Math.PI) / 180
          const ox = cx + scotomaR * maxR * Math.cos(rad)
          const oy = cy + scotomaR * maxR * Math.sin(rad)

          const orbSize = orb.size * (0.5 + ci * 0.8)

          // Corona ring (bright edge)
          ctx.beginPath()
          ctx.arc(ox, oy, orbSize, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(200, 220, 255, ${Math.min(1, alpha * 0.9)})`
          ctx.lineWidth = 1.5 + ci * 1.5
          ctx.stroke()

          // Outer glow ring
          ctx.beginPath()
          ctx.arc(ox, oy, orbSize * 1.3, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(180, 200, 255, ${Math.min(1, alpha * 0.35)})`
          ctx.lineWidth = 1 + ci
          ctx.stroke()

          // Dimmer filled center (limb brightening: edge > center)
          const centerGrad = ctx.createRadialGradient(ox, oy, 0, ox, oy, orbSize)
          centerGrad.addColorStop(0, `rgba(150, 180, 255, ${Math.min(1, alpha * 0.15)})`)
          centerGrad.addColorStop(0.6, `rgba(180, 210, 255, ${Math.min(1, alpha * 0.1)})`)
          centerGrad.addColorStop(1, `rgba(210, 230, 255, ${Math.min(1, alpha * 0.5)})`)
          ctx.fillStyle = centerGrad
          ctx.beginPath()
          ctx.arc(ox, oy, orbSize, 0, Math.PI * 2)
          ctx.fill()

          // Occasional bright spike/flare from edge
          if (flicker > 0.7 && Math.random() < 0.4) {
            const spikeAngle = Math.random() * Math.PI * 2
            const spikeLen = orbSize * (1.5 + Math.random() * 2)
            ctx.beginPath()
            ctx.moveTo(
              ox + orbSize * 0.8 * Math.cos(spikeAngle),
              oy + orbSize * 0.8 * Math.sin(spikeAngle),
            )
            ctx.lineTo(
              ox + spikeLen * Math.cos(spikeAngle),
              oy + spikeLen * Math.sin(spikeAngle),
            )
            ctx.strokeStyle = `rgba(220, 240, 255, ${Math.min(1, alpha * 0.6)})`
            ctx.lineWidth = 0.5 + Math.random() * 1
            ctx.stroke()
          }
        }
      }

      // ---- Floaters (dark drifting translucent shapes) ----
      if (effects.has('floaters')) {
        const fi = intensities.floaters ?? 0.5
        const flts = floaterStateRef.current
        for (const f of flts) {
          f.x += f.vx * dt * 60
          f.y += f.vy * dt * 60
          // Wrap around
          if (f.y > 1.1) { f.y = -0.1; f.x = Math.random() }
          if (f.x < -0.1) f.x = 1.1
          if (f.x > 1.1) f.x = -0.1

          const fx = f.x * w
          const fy = f.y * h

          ctx.save()
          ctx.translate(fx, fy)
          ctx.globalAlpha = f.opacity * (0.4 + fi * 1.2) // opacity scales with intensity
          ctx.fillStyle = 'rgba(20, 15, 10, 1)'
          ctx.beginPath()
          // Irregular blobby shape using stored shape params
          const pts = f.shape.length
          for (let j = 0; j <= pts; j++) {
            const a = (j / pts) * Math.PI * 2
            const r = f.size * (0.6 + fi * 0.8) * f.shape[j % pts]
            const x = r * Math.cos(a)
            const y = r * Math.sin(a) * 0.6 // flattened
            if (j === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.closePath()
          ctx.filter = 'blur(3px)'
          ctx.fill()
          ctx.filter = 'none'
          ctx.restore()
        }
      }

      effectRafRef.current = requestAnimationFrame(renderEffects)
    }

    effectRafRef.current = requestAnimationFrame(renderEffects)
    return () => cancelAnimationFrame(effectRafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // Restart loop when the set of active effects changes (not on intensity changes)
    [...activeEffects].sort().join(','),
    allBoundaries,
  ])

  const handleDownload = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = `vision-sim-${formatEyeLabelForResult(eye)}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  const handleShare = async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) return
      if ('share' in navigator) {
        const file = new File([blob], `vision-sim-${formatEyeLabelForResult(eye)}.png`, {
          type: 'image/png',
        })
        await navigator.share({ title: 'My visual field simulation', files: [file] })
      } else {
        handleDownload()
      }
    } catch {
      handleDownload()
    }
  }

  // Close expanded view on Escape key
  useEffect(() => {
    if (!expanded) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [expanded])

  // ---------- Shared content blocks ----------

  const canvasBlock = (
    <div
      className={`relative overflow-hidden bg-gray-900 ${
        expanded ? 'rounded-2xl' : 'rounded-xl'
      } ${cameraActive ? 'ring-2 ring-emerald-500/40 shadow-lg shadow-emerald-500/10' : ''}`}
    >
      {loading && !cameraActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80 z-10">
          <span className="text-gray-400 text-sm animate-pulse">Loading image...</span>
        </div>
      )}
      {cameraActive && (
        <>
          <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-black/60 backdrop-blur-sm rounded-full px-3 py-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-[11px] text-white/80 font-medium">Live</span>
          </div>
          <div className="absolute bottom-3 right-3 z-10 bg-black/50 backdrop-blur-sm rounded-lg px-2.5 py-1">
            <span className="text-xs text-white/50">RP vision simulation</span>
          </div>
        </>
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-auto block"
      />
      {activeEffects.size > 0 && (
        <canvas
          ref={overlayRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />
      )}
      {/* Expand / collapse button on the canvas */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="absolute top-3 right-3 z-10 bg-black/50 backdrop-blur-sm hover:bg-black/70 rounded-lg p-1.5 transition-colors"
        title={expanded ? 'Exit fullscreen' : 'Expand'}
      >
        {expanded ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5">
            <polyline points="6,2 2,2 2,6" /><polyline points="10,14 14,14 14,10" />
            <line x1="2" y1="2" x2="6.5" y2="6.5" /><line x1="14" y1="14" x2="9.5" y2="9.5" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5">
            <polyline points="10,2 14,2 14,6" /><polyline points="6,14 2,14 2,10" />
            <line x1="14" y1="2" x2="9.5" y2="6.5" /><line x1="2" y1="14" x2="6.5" y2="9.5" />
          </svg>
        )}
      </button>
    </div>
  )

  const controlsBlock = (
    <>
      {/* Darkness slider */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500 shrink-0">Lighter</span>
        <input
          type="range"
          min={0}
          max={100}
          value={darkness * 100}
          onChange={e => handleDarknessChange(Number(e.target.value) / 100)}
          className="flex-1 h-1.5 rounded-full appearance-none bg-gray-800 accent-blue-500 cursor-pointer"
        />
        <span className="text-xs text-gray-500 shrink-0">Darker</span>
      </div>

      {/* Blur slider */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500 shrink-0">Sharp</span>
        <input
          type="range"
          min={0}
          max={100}
          value={blurAmount * 100}
          onChange={e => handleBlurChange(Number(e.target.value) / 100)}
          className="flex-1 h-1.5 rounded-full appearance-none bg-gray-800 accent-purple-500 cursor-pointer"
        />
        <span className="text-xs text-gray-500 shrink-0">Blurry</span>
      </div>

      {/* Visual effects panel */}
      <div className="space-y-2">
        <button
          onClick={() => setShowEffectsPanel(v => !v)}
          className="flex items-center gap-2 text-xs text-gray-400 hover:text-white transition-colors"
        >
          <span className={`transition-transform ${showEffectsPanel ? 'rotate-90' : ''}`}>&#9654;</span>
          Visual phenomena
          {activeEffects.size > 0 && (
            <span className="bg-purple-600/20 text-purple-400 px-1.5 py-0.5 rounded-full text-xs">
              {activeEffects.size} active
            </span>
          )}
        </button>

        {showEffectsPanel && (
          <div className={`grid gap-2 ${expanded ? 'grid-cols-4' : 'grid-cols-2'}`}>
            {(Object.keys(EFFECT_INFO) as VisualEffect[]).map(key => {
              const info = EFFECT_INFO[key]
              const active = activeEffects.has(key)
              const intensity = effectIntensities[key] ?? 0
              return (
                <div
                  key={key}
                  className={`text-left px-3 py-2 rounded-lg text-xs transition-colors border ${
                    active
                      ? 'bg-purple-600/15 text-purple-300 border-purple-500/30'
                      : 'bg-gray-900 text-gray-400 border-gray-800 hover:border-gray-700 hover:text-gray-300'
                  }`}
                >
                  <button
                    onClick={() => toggleEffect(key)}
                    className="w-full text-left"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{info.label}</span>
                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                        active ? 'bg-purple-500 border-purple-400' : 'border-gray-600'
                      }`}>
                        {active && (
                          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2">
                            <polyline points="2,5 4.5,7.5 8,3" />
                          </svg>
                        )}
                      </span>
                    </div>
                    <div className="text-xs mt-0.5 opacity-60">{info.desc}</div>
                    <div className="text-[9px] mt-0.5 opacity-40">{info.prevalence}</div>
                  </button>
                  {active && (
                    <div className="flex items-center gap-2 mt-2 pt-1.5 border-t border-purple-500/10">
                      <span className="text-[9px] opacity-40 shrink-0">Low</span>
                      <input
                        type="range"
                        min={5}
                        max={100}
                        value={Math.round(intensity * 100)}
                        onChange={e => setEffectIntensity(key, Number(e.target.value) / 100)}
                        className="flex-1 h-1 rounded-full appearance-none bg-gray-800 accent-purple-500 cursor-pointer"
                      />
                      <span className="text-[9px] opacity-40 shrink-0">High</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        {SCENE_OPTIONS.map(opt => (
          <button
            key={opt.url}
            onClick={() => { stopCamera(); setCustomImage(null); setSceneUrl(opt.url) }}
            className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
              !customImage && sceneUrl === opt.url
                ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => fileInputRef.current?.click()}
          className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
            customImage
              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
              : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
          }`}
        >
          Your photo
        </button>
        <button
          onClick={() => {
            if (cameraActive) { stopCamera() } else {
              stopCamera() // ensure clean state
              startCamera()
            }
          }}
          className={`text-xs px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
            cameraActive
              ? 'bg-red-600/20 text-red-400 border border-red-500/30'
              : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
          }`}
        >
          {cameraActive ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
              Stop
            </>
          ) : (
            <>📷 Live POV</>
          )}
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleUpload} className="hidden" />
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleShare}
          className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
        >
          {'share' in navigator ? 'Share' : 'Download'} image
        </button>
        {'share' in navigator && (
          <button
            onClick={handleDownload}
            className="py-2 px-4 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
          >
            Save
          </button>
        )}
      </div>
    </>
  )

  // ---------- Expanded (fullscreen modal) ----------
  if (expanded) {
    return (
      <>
        {/* Keep a placeholder in the normal flow so layout doesn't jump */}
        <div className="space-y-3">
          <div className="rounded-xl bg-gray-900/50 border border-gray-800 p-8 text-center">
            <span className="text-xs text-gray-500">Simulation expanded — </span>
            <button onClick={() => setExpanded(false)} className="text-xs text-blue-400 hover:text-blue-300 underline">
              close
            </button>
          </div>
        </div>

        {/* Fullscreen overlay */}
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col">
          {/* Header bar */}
          <div className="flex items-center justify-between px-6 py-3 bg-gray-950/80 border-b border-gray-800/50">
            <h3 className="text-sm font-medium text-gray-300">Vision simulation</h3>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowBoth(v => !v)}
                className={`text-xs px-2 py-1 rounded ${
                  showBoth ? 'bg-blue-600/20 text-blue-400' : 'bg-gray-800 text-gray-400 hover:text-white'
                } transition-colors`}
              >
                {showBoth ? 'Side by side' : 'Compare'}
              </button>
              <button
                onClick={() => setExpanded(false)}
                className="text-gray-400 hover:text-white transition-colors p-1"
                title="Close (Esc)"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <line x1="5" y1="5" x2="15" y2="15" /><line x1="15" y1="5" x2="5" y2="15" />
                </svg>
              </button>
            </div>
          </div>

          {/* Canvas — takes up most space */}
          <div className="flex-1 flex items-center justify-center p-4 min-h-0">
            <div className="max-w-5xl w-full max-h-full">
              {canvasBlock}
            </div>
          </div>

          {/* Controls bar at bottom */}
          <div className="px-6 py-4 bg-gray-950/80 border-t border-gray-800/50 space-y-3 max-h-[40vh] overflow-y-auto">
            {controlsBlock}
          </div>
        </div>
      </>
    )
  }

  // ---------- Normal (inline) ----------
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">Vision simulation</h3>
        <button
          onClick={() => setShowBoth(v => !v)}
          className={`text-xs px-2 py-1 rounded ${
            showBoth
              ? 'bg-blue-600/20 text-blue-400'
              : 'bg-gray-800 text-gray-400 hover:text-white'
          } transition-colors`}
        >
          {showBoth ? 'Side by side' : 'Compare'}
        </button>
      </div>

      {canvasBlock}
      {controlsBlock}

      <div className="flex items-center gap-3 flex-wrap text-[10px] text-gray-500 px-1">
        <span className="text-gray-600 uppercase tracking-wider">Legend</span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-4 h-4 rounded-sm border border-gray-700"
            style={{ background: 'radial-gradient(circle at 50% 50%, #cbd5e1, #94a3b8)' }}
            aria-hidden="true"
          />
          Sharp — preserved field
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-4 h-4 rounded-sm border border-gray-700"
            style={{ background: 'radial-gradient(circle at 50% 50%, #64748b, #334155)', filter: 'blur(0.5px)' }}
            aria-hidden="true"
          />
          Blurred — reduced sensitivity
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-4 h-4 rounded-sm border border-gray-700 bg-black"
            aria-hidden="true"
          />
          Dark — scotoma / no light detected
        </span>
      </div>

      <p className="text-xs text-gray-600 leading-relaxed">
        This is an approximate simulation of how your visual field loss might affect everyday vision.
        Actual perception varies — your brain fills in gaps, and both eyes work together.
        This shows the deficit from one eye only. Multiple dark rings indicate a double scotoma pattern.
      </p>
    </div>
  )
}

/**
 * Create a blurred copy of an image using downscale-upscale technique.
 * This works in ALL browsers (Safari, Firefox, Chrome) unlike ctx.filter.
 * The blur amount is controlled by how much we downscale:
 * factor 1 = no blur, factor 0.1 = heavy blur, factor 0.02 = extreme blur.
 */
function createBlurredCanvas(
  img: HTMLImageElement,
  w: number,
  h: number,
  scaleFactor: number,
): ImageData {
  // Step 1: Draw image at reduced size
  const smallW = Math.max(2, Math.round(w * scaleFactor))
  const smallH = Math.max(2, Math.round(h * scaleFactor))

  const small = document.createElement('canvas')
  small.width = smallW
  small.height = smallH
  const sCtx = small.getContext('2d')!
  sCtx.imageSmoothingEnabled = true
  sCtx.imageSmoothingQuality = 'high'
  sCtx.drawImage(img, 0, 0, smallW, smallH)

  // Step 2: For extra blur, do another downscale pass
  if (scaleFactor < 0.15) {
    const tinyW = Math.max(2, Math.round(smallW * 0.5))
    const tinyH = Math.max(2, Math.round(smallH * 0.5))
    const tiny = document.createElement('canvas')
    tiny.width = tinyW
    tiny.height = tinyH
    const tCtx = tiny.getContext('2d')!
    tCtx.imageSmoothingEnabled = true
    tCtx.imageSmoothingQuality = 'high'
    tCtx.drawImage(small, 0, 0, tinyW, tinyH)

    // Scale tiny back to small
    sCtx.clearRect(0, 0, smallW, smallH)
    sCtx.drawImage(tiny, 0, 0, smallW, smallH)
  }

  // Step 3: Scale back up to full size
  const full = document.createElement('canvas')
  full.width = w
  full.height = h
  const fCtx = full.getContext('2d')!
  fCtx.imageSmoothingEnabled = true
  fCtx.imageSmoothingQuality = 'high'
  fCtx.drawImage(small, 0, 0, w, h)

  return fCtx.getImageData(0, 0, w, h)
}

// Scale factors for blur levels (smaller = more blur):
// 1.0 = sharp, 0.25 = mild soft, 0.05 = features gone,
// 0.01 = pure color, 0.003 = total wipeout (1200px → 3-4px)
const BLUR_SCALES = [1.0, 0.25, 0.05, 0.01, 0.003]

/**
 * Apply visual field loss with smooth continuous gradients.
 *
 * For each pixel:
 * 1. Compute vision quality (0–1) from all isopter boundaries
 * 2. Use quality to interpolate between blur levels (pre-computed canvases)
 * 3. Apply darkness proportional to (1 - quality) × user slider
 *
 * Boundaries are resampled to 1° resolution with cubic interpolation,
 * and quality transitions use smoothstep for soft organic edges.
 */
function applyFieldLoss(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  boundaries: IsopterBoundary[],
  xStart: number,
  xEnd: number,
  darknessLevel: number,
  blurLevel: number = 0.5,
) {
  if (boundaries.length === 0) return

  const cx = w / 2
  const cy = h / 2
  // Use circular normalization so the scotoma pattern is round, not rectangular.
  // maxR = half the shorter dimension. Corners beyond this are treated as scotoma.
  const maxR = Math.min(w, h) / 2

  // Pre-compute blurred versions of the image at different scale factors
  const blurredData: ImageData[] = BLUR_SCALES.map(s =>
    s >= 1.0 ? ctx.getImageData(0, 0, w, h) : createBlurredCanvas(img, w, h, s),
  )

  const imageData = ctx.getImageData(0, 0, w, h)
  const outData = imageData.data

  for (let py = 0; py < h; py++) {
    for (let px = xStart; px < xEnd; px++) {
      const dx = px - cx
      const dy = -(py - cy)
      const dist = Math.sqrt(dx * dx + dy * dy) / maxR

      let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI
      if (angleDeg < 0) angleDeg += 360

      const quality = getVisionQuality(dist, angleDeg, boundaries)

      if (quality >= 0.99) continue // Perfect vision — skip

      const idx = (py * w + px) * 4

      // Map quality to blur level, scaled by user's blur slider.
      // blurLevel 0 = no blur at all, 1 = maximum blur in scotoma.
      // The blur gradient naturally follows quality: sharpest at field edges,
      // most blurred at the deepest scotoma.
      const blurT = (1 - quality) * (BLUR_SCALES.length - 1) * blurLevel
      const clampedBlurT = Math.min(blurT, BLUR_SCALES.length - 1 - 0.01)
      const blurIdx = Math.min(Math.floor(clampedBlurT), BLUR_SCALES.length - 2)
      const blurFrac = clampedBlurT - blurIdx

      // Interpolate between two adjacent blur levels
      const d1 = blurredData[blurIdx].data
      const d2 = blurredData[blurIdx + 1].data
      const r = d1[idx] * (1 - blurFrac) + d2[idx] * blurFrac
      const g = d1[idx + 1] * (1 - blurFrac) + d2[idx + 1] * blurFrac
      const b = d1[idx + 2] * (1 - blurFrac) + d2[idx + 2] * blurFrac

      // Apply darkness: scale by quality and user slider
      const keep = 1 - (1 - quality) * darknessLevel * 0.95
      outData[idx] = Math.round(r * keep)
      outData[idx + 1] = Math.round(g * keep)
      outData[idx + 2] = Math.round(b * keep)
    }
  }

  ctx.putImageData(imageData, 0, 0)
}
