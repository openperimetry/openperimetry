import type { TestPoint, StimulusKey } from './types'
import { STIMULI, ISOPTER_ORDER } from './types'

const CHART_PADDING = 40

/** Display range for the measured (staircase) sensitivity heatmap.
 *
 *  The measured dB range for real thresholds is roughly 0–35 on a consumer
 *  monitor (0 = patient needs max brightness to detect, higher = more
 *  sensitive, sees dimmer stimuli). We pad both ends for the heatmap
 *  colormap:
 *
 *  - `DB_MIN = -5` is a sentinel for "saw nothing even at max brightness."
 *    It's intentionally below 0 because such a location's true threshold is
 *    below what the display can produce — the patient needs *more* than
 *    max brightness. Using a sub-zero sentinel lets the heatmap color these
 *    locations at the warm end without conflating them with a true 0 dB.
 *  - `DB_MAX = 40` extends slightly above the usable measurement ceiling so
 *    high-sensitivity values aren't clipped.
 */
export const DB_MIN = -5
export const DB_MAX = 40

/** Display range for the *derived* sensitivity heatmap (both Goldmann
 *  and static scatter, when derived from suprathreshold Goldmann-level
 *  detections).
 *
 *  Mirrors the clinical heatmap convention (warm = scotoma / only bright
 *  stimulus seen; cool = dim stimulus detected) but clamps the upper end
 *  at the dimmest Goldmann stimulus this app uses (I2e/III2e, 10 dB)
 *  rather than at a clinical threshold ceiling like 17 dB. Published
 *  reference images stretch to 17 because their underlying data is true
 *  threshold measurement that can resolve intermediate values; our
 *  derived path only has two real samples (0 dB when V4e-only seen,
 *  10 dB when I2e/III2e seen), so capping at 10 makes the highest-
 *  sensitivity zone saturate to deep blue instead of landing at
 *  yellow-green (t≈0.59) where it would be visually indistinguishable
 *  from transitional regions.
 *
 *  With the [0, 10] range:
 *    - unseen sentinel (-5)  → clamps to t=0    → vivid red       (scotoma)
 *    - V4e-only seen (0)     → t=0              → vivid red
 *    - (gaussian blend zone) → t≈0.3–0.7        → orange→yellow→green
 *    - I2e/III2e seen (10)   → t=1              → deep blue       (sensitive)
 *
 *  Why the same ramp for both test types: a caption above each map already
 *  names whether the data is static or kinetic, so the ramp doesn't have
 *  to carry that distinction. The Gaussian smoother in
 *  `renderSensitivityToCanvas` gives the expected red → orange → yellow →
 *  green → blue concentric rings around sensitive zones regardless of
 *  stimulus-delivery method.
 */
export const DB_MIN_DERIVED = 0
export const DB_MAX_DERIVED = 10

/** Convert a stimulus opacity (0–1, with 1 = brightest) to dB using the
 *  psychophysics convention `dB = -10·log10(opacity)`. Matches SPECVIS's
 *  ThresholdDecibel axis: 0 dB = brightest, higher = dimmer = more sensitive. */
export function opacityToDb(opacity: number): number {
  if (opacity <= 0) return DB_MAX
  return -10 * Math.log10(opacity)
}

/** Inverse of opacityToDb. Guards against non-finite input and clamps to [0, 1]. */
export function dbToOpacity(db: number): number {
  if (!Number.isFinite(db)) return 0
  const op = Math.pow(10, -db / 10)
  return Math.min(1, Math.max(0, op))
}

export interface DerivedPoint {
  meridianDeg: number
  eccentricityDeg: number
  db: number
}

interface DbSample {
  meridianDeg: number
  eccentricityDeg: number
  db: number
}

/** Reversed jet colormap matching matplotlib's `jet_r`. Low t = low dB =
 *  insensitive = warm (red). High t = high dB = sensitive = cool (blue).
 *  Mirrors SPECVIS's `cmap='jet_r'` in DisplayResults.py so the visual
 *  encoding is familiar. Returns 0–255 RGB.
 *
 *  We remap the input into jet_r's [0.15, 0.95] subrange to skip the two
 *  darkest extremes of the raw colormap (pure `jet_r` bottoms out at
 *  `rgb(128, 0, 0)` maroon and tops out at `rgb(0, 0, 128)` navy, both of
 *  which read as "dark spots" rather than colored values). The clipped
 *  subrange preserves the warm→cool semantic while keeping the whole image
 *  legible, especially when unseen-sentinel points (`db = DB_MIN`) would
 *  otherwise paint the sample grid as near-black dots on a reddish field. */
export function jetReverseColor(t: number): { r: number; g: number; b: number } {
  const clamped = Math.min(1, Math.max(0, t))
  const remapped = 0.15 + 0.8 * clamped
  const x = 1 - remapped
  const r = Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 3))))
  const g = Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 2))))
  const b = Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 1))))
  return { r, g, b }
}

/** Paint a sensitivity heatmap onto the given 2D canvas context.
 *
 *  Uses a **Gaussian-weighted max aggregation** over all samples: for each
 *  pixel, each sample contributes an "influence" equal to its dB value
 *  attenuated by the Gaussian `exp(-d²/(2σ²))` of its distance to the
 *  pixel, and the pixel takes the *maximum* influence from any sample
 *  (floored at `dbMin`). This produces the classic clinical-heatmap look:
 *  a sample with high sensitivity casts a smooth blue aura that decays
 *  radially through green/yellow/orange to red as you move away from it,
 *  and separate high-sensitivity samples merge into a single sensitive
 *  region rather than averaging against surrounding scotomatous samples.
 *
 *  Why max instead of Gaussian *average* (weighted-mean IDW's cousin):
 *  derived Goldmann data is sparse and semi-binary — most bucketed
 *  samples are `db=0` (V4e seen, probed everywhere) and a handful are
 *  `db=10` (I2e/III2e seen, probed only along a few meridians). Averaging
 *  dilutes the rare high-dB samples into the surrounding mass of 0-dB
 *  samples, so the central sensitive zone collapses to red. Max treats
 *  the high-dB samples as "evidence that at least this much sensitivity
 *  exists here," which matches how clinicians read these maps: the I2e
 *  isopter defines the boundary of at-least-10-dB vision, not an average
 *  of measurements spanning 0–10.
 *
 *  `power` is accepted for API compatibility with older callers but is
 *  unused — the kernel is Gaussian, not inverse-distance.
 *
 *  `dbMin`/`dbMax` default to the measured-mode ramp (`DB_MIN`/`DB_MAX`).
 *  For derived (Goldmann-level) data pass `DB_MIN_DERIVED` /
 *  `DB_MAX_DERIVED`. */
export function renderSensitivityToCanvas(
  ctx: CanvasRenderingContext2D,
  points: DbSample[],
  size: number,
  maxEccentricityDeg: number,
  _power = 2,
  dbMin: number = DB_MIN,
  dbMax: number = DB_MAX,
): void {
  void _power
  ctx.clearRect(0, 0, size, size)
  const validPoints = points.filter(p => Number.isFinite(p.db))
  if (validPoints.length === 0) return
  if (maxEccentricityDeg <= 0) return

  const center = size / 2
  const radius = center - CHART_PADDING

  const samples = validPoints.map(p => {
    const rad = (p.meridianDeg * Math.PI) / 180
    const r = (p.eccentricityDeg / maxEccentricityDeg) * radius
    // Clamp each sample's dB to the display range at ingestion so the
    // max-aggregator below operates on the visible scale. The unseen
    // sentinel (-5 dB in derived data) thus becomes `dbMin`, matching
    // "no evidence of sensitivity" rather than casting a below-scale
    // influence that would confusingly pull neighbors below dbMin.
    const db = Math.max(dbMin, Math.min(dbMax, p.db))
    return { x: center + r * Math.cos(rad), y: center - r * Math.sin(rad), db }
  })

  // σ controls how far each sample's aura spreads. Was 15% of radius,
  // which merged adjacent dim-seen clusters into a single symmetric
  // blob and erased the real nasal/temporal or superior/inferior
  // asymmetries in the data. 9% keeps each cluster's aura roughly the
  // size of the cluster itself — enough for smooth concentric rings
  // around it but tight enough that two offset clusters stay visually
  // distinct, so asymmetric fields read as asymmetric on the map.
  // Floor at 8 px so small canvases still produce a visible aura.
  const sigma = Math.max(8, radius * 0.09)
  const twoSigma2 = 2 * sigma * sigma

  // Separate, wider kernel for the corroboration step. Ring-shaped sample
  // topologies (our Goldmann-derived data) put peers at the ring's arc
  // spacing — e.g. 12 samples around an isopter at 40° radius are ~21°
  // apart, much further than the render σ of ~4–5°. Using render σ for
  // density would leave every ring sample with near-zero confidence and
  // paint healthy fields entirely red. σ_conf ≈ 25% of radius is wide
  // enough that adjacent ring neighbors corroborate, while still rejecting
  // a genuinely isolated outlier sitting alone in an empty quadrant.
  const sigmaConf = Math.max(12, radius * 0.25)
  const twoSigmaConf2 = 2 * sigmaConf * sigmaConf

  // Per-sample confidence: scales each sample's aura by how many
  // equal-or-higher-dB neighbors it has within σ. An isolated
  // above-baseline sample (e.g., a single peripheral I2e-seen point with
  // no other dim-seen samples nearby) has no corroborating peers so its
  // aura fades to the red baseline; a dense cluster of dim-seen points
  // mutually reinforces and renders at full intensity. This is the
  // clinical "require corroboration before drawing an island" rule —
  // single samples shouldn't paint the same bold blue zone as 20 samples.
  //
  // Density normalizes so ≥ CONFIDENCE_FULL peers at d=0 give confidence 1;
  // raising the threshold requires larger clusters before the aura
  // saturates. Baseline samples (db ≈ dbMin) don't need confidence since
  // their aura contribution is zero regardless.
  // Lowered from 2 → 1.5 so the tighter σ (9% of radius) doesn't
  // over-suppress real clusters: fewer peers now fall inside σ, so a
  // threshold of "2 supporters for full confidence" would wipe out
  // small-but-real clusters of 3–4 dim-seen samples.
  const CONFIDENCE_FULL = 1.5
  const confidences = new Array<number>(samples.length)
  for (let i = 0; i < samples.length; i++) {
    let density = 0
    for (let j = 0; j < samples.length; j++) {
      if (i === j) continue
      // Only peers with db ≥ this sample's db count as corroboration —
      // a V4e-seen neighbor doesn't support an I2e-seen sample's claim
      // of "at least 10 dB sensitivity here."
      if (samples[j].db < samples[i].db) continue
      const ddx = samples[i].x - samples[j].x
      const ddy = samples[i].y - samples[j].y
      density += Math.exp(-(ddx * ddx + ddy * ddy) / twoSigmaConf2)
    }
    confidences[i] = Math.min(1, density / CONFIDENCE_FULL)
  }

  const img = ctx.createImageData(size, size)
  const step = 2
  for (let py = 0; py < size; py += step) {
    for (let px = 0; px < size; px += step) {
      const dx = px - center
      const dy = py - center
      if (dx * dx + dy * dy > radius * radius) continue
      let bestInfluence = dbMin
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]
        const d2 = (s.x - px) * (s.x - px) + (s.y - py) * (s.y - py)
        const proximity = Math.exp(-d2 / twoSigma2)
        // Influence blends the sample's dB toward dbMin with distance
        // AND by confidence: at the sample center with full confidence,
        // influence = s.db; at infinity, influence = dbMin; at any
        // distance with zero confidence, influence = dbMin (sample is
        // effectively invisible). Max over all samples gives each pixel
        // its best-corroborated sensitivity.
        const influence = dbMin + (s.db - dbMin) * confidences[i] * proximity
        if (influence > bestInfluence) bestInfluence = influence
      }
      const t = (bestInfluence - dbMin) / (dbMax - dbMin)
      const { r, g, b } = jetReverseColor(t)
      for (let ky = 0; ky < step && py + ky < size; ky++) {
        for (let kx = 0; kx < step && px + kx < size; kx++) {
          const idx = ((py + ky) * size + (px + kx)) * 4
          img.data[idx] = r
          img.data[idx + 1] = g
          img.data[idx + 2] = b
          img.data[idx + 3] = 255
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0)

  // Fixation crosshair (SPECVIS overlays a '+' at fixation)
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(center - 6, center)
  ctx.lineTo(center + 6, center)
  ctx.moveTo(center, center - 6)
  ctx.lineTo(center, center + 6)
  ctx.stroke()
}

/** Approximate per-location sensitivity in dB from Goldmann-level
 *  suprathreshold data.
 *
 *  Goldmann testing records *isopter boundaries* — the furthest eccentricity
 *  at which each stimulus was still detected along each meridian. Earlier
 *  versions of this function only emitted samples at those boundaries,
 *  which produced a sparse ring of points and left the field centre empty.
 *  The renderer then painted the unsampled interior as red ("insensitive")
 *  even though, clinically, any location *inside* an isopter is known to
 *  at least detect that stimulus. The correct interpretation is:
 *
 *    If stimulus S was seen at (m, r), then S is visible at every (m, r')
 *    with r' ≤ r along that meridian. The dimmest S visible at (m, r')
 *    determines the derived dB — dimmer = higher dB = more sensitive.
 *
 *  We therefore build a polar grid of synthetic samples covering the full
 *  testable field and, for each grid point, find the dimmest stimulus
 *  whose interpolated isopter at that meridian still encloses the point.
 *  The output is a dense grid the heatmap renderer can blur smoothly,
 *  instead of a sparse ring of boundary points.
 *
 *  Catch trials are ignored; unseen-only meridians get DB_MIN.
 */
export function deriveDbFromSuprathreshold(points: TestPoint[]): DerivedPoint[] {
  const testPoints = points.filter(p => !p.catchTrial)
  if (testPoints.length === 0) return []

  // Build per-stimulus detected-sample lists, sorted by meridian, for
  // isopter-boundary interpolation. A single detected sample defines a
  // flat isopter at its eccentricity; with more samples we linearly
  // interpolate between meridian-adjacent neighbours (wrapping at 360°).
  const byStim: Record<StimulusKey, Array<{ m: number; r: number }>> = {
    V4e: [], III4e: [], III2e: [], I4e: [], I2e: [],
  }
  for (const p of testPoints) {
    if (!p.detected) continue
    byStim[p.stimulus].push({ m: ((p.meridianDeg % 360) + 360) % 360, r: p.eccentricityDeg })
  }
  for (const k of ISOPTER_ORDER) byStim[k].sort((a, b) => a.m - b.m)

  function isopterRadiusAt(stim: StimulusKey, m: number): number | null {
    const arr = byStim[stim]
    if (arr.length === 0) return null
    if (arr.length === 1) return arr[0].r
    const mm = ((m % 360) + 360) % 360
    // Find the pair straddling mm. Since `arr` is sorted by meridian,
    // walk to the first entry with meridian ≥ mm; interpolate between
    // that entry and the previous one (wrapping at the ends).
    let i = 0
    while (i < arr.length && arr[i].m < mm) i++
    const hi = arr[i % arr.length]
    const lo = arr[(i - 1 + arr.length) % arr.length]
    // Shortest-arc distance (handles wrap at 0/360)
    let span = hi.m - lo.m
    if (span <= 0) span += 360
    let offset = mm - lo.m
    if (offset < 0) offset += 360
    const t = span === 0 ? 0 : offset / span
    return lo.r + (hi.r - lo.r) * t
  }

  // Determine the radial extent of the grid. Include a small margin past
  // the furthest detected sample so the outer "red" halo is rendered.
  let maxR = 0
  for (const p of testPoints) if (p.eccentricityDeg > maxR) maxR = p.eccentricityDeg
  const gridMaxR = Math.max(10, Math.ceil(maxR + 5))

  // Polar grid resolution. Tight enough that the arc spacing at the
  // outermost radius stays well below the renderer's Gaussian σ (≈9% of
  // map radius). At 3° meridian steps and r=50°, arc spacing is
  // 2π·50/120 ≈ 2.6° — many times smaller than σ, so the Gaussian kernel
  // smears adjacent meridian samples into continuous rings instead of
  // visible stripes radiating outward.
  const MERIDIAN_STEP = 3
  const RADIAL_STEP = 1.5

  const out: DerivedPoint[] = []
  for (let m = 0; m < 360; m += MERIDIAN_STEP) {
    // Always include the centre point (r=0) per meridian — prevents the
    // renderer from leaving the fovea as an unsampled red hole when the
    // innermost detected sample is several degrees out.
    for (let r = 0; r <= gridMaxR; r += RADIAL_STEP) {
      // Dimmest stimulus visible = smallest intensityFrac among stimuli
      // whose isopter at this meridian encloses (m, r).
      let dimmest: number | null = null
      for (const stim of ISOPTER_ORDER) {
        const boundary = isopterRadiusAt(stim, m)
        if (boundary == null) continue
        if (boundary >= r) {
          const f = STIMULI[stim].intensityFrac
          if (dimmest === null || f < dimmest) dimmest = f
        }
      }
      const db = dimmest === null ? DB_MIN : opacityToDb(dimmest)
      out.push({ meridianDeg: m, eccentricityDeg: r, db })
    }
  }
  return out
}
