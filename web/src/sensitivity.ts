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

/** Convert a stimulus opacity (0–1, with 1 = brightest) to dB using the
 *  psychophysics convention `dB = -10·log10(opacity)`. Matches SPECVIS's
 *  ThresholdDecibel axis: 0 dB = brightest, higher = dimmer = more sensitive.
 *
 *  ⚠ CAVEAT — opacity is NOT calibrated luminance. This formula equals the
 *  clinical `10·log10(L_max/L)` only if emitted light is *linear* in opacity.
 *  A real display applies sRGB gamma (emitted L ≈ opacity^~2.2) and a non-zero
 *  black level, so equal dB steps here are not equal log-luminance steps and
 *  the whole scale is compressed by roughly the gamma factor (e.g. opacity 0.5
 *  reports 3.0 dB but emits ~0.22 of max → true ≈ 6.6 dB). Treat these dB as a
 *  self-consistent *relative* index on one screen, NOT absolute clinical dB
 *  comparable to a hospital perimeter, unless gamma + black level are
 *  calibrated out first. See docs/math/math-validation-report.md (C1). */
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
 *  Kept exported because some legacy call sites still use it; the
 *  primary heatmap renderer has switched to {@link sensitivityGreyForT}
 *  to match the HFA-style clinical greyscale plot convention. */
export function jetReverseColor(t: number): { r: number; g: number; b: number } {
  const clamped = Math.min(1, Math.max(0, t))
  const remapped = 0.15 + 0.8 * clamped
  const x = 1 - remapped
  const r = Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 3))))
  const g = Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 2))))
  const b = Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 1))))
  return { r, g, b }
}

/** Greyscale colour for a normalised sensitivity value t ∈ [0,1]. Matches
 *  the HFA Single-Field-Analysis greyscale plot convention: white = normal
 *  sensitivity, dark = defect. Floors at ~20 (very-dark grey, not pure
 *  black) so a profound defect is still distinguishable from the canvas
 *  background, and ceilings at ~250 so the brightest pixel doesn't fully
 *  saturate against the surrounding chrome. */
export function sensitivityGreyForT(t: number): { r: number; g: number; b: number } {
  const clamped = Math.min(1, Math.max(0, t))
  const v = Math.round(20 + (250 - 20) * clamped)
  return { r: v, g: v, b: v }
}

/** Paint a sensitivity heatmap onto the given 2D canvas context.
 *
 *  Uses a **Gaussian-weighted mean** over all samples: for each pixel, each
 *  sample contributes weight `exp(-d²/(2σ²))` where d is the pixel-to-sample
 *  distance, and the pixel takes the weighted mean of sample dB values. This
 *  produces a smooth concentric-ring heatmap — nearby samples dominate,
 *  distant samples fade — matching the matplotlib/SPECVIS `imshow` +
 *  Gaussian-blur output clinicians expect.
 *
 *  Inputs are per-location threshold measurements (dB, from a 4-2 staircase
 *  or equivalent). No suprathreshold/derived-dB mode: if a caller has no
 *  threshold data, it should skip rendering instead of passing synthetic
 *  points. */
export function renderSensitivityToCanvas(
  ctx: CanvasRenderingContext2D,
  points: DbSample[],
  size: number,
  maxEccentricityDeg: number,
  /** Optional dB upper bound for the colormap. When the test is
   *  calibration-limited (e.g. a brightnessFloor of 0.075 caps
   *  thresholds at ~11 dB), pass the effective ceiling so the
   *  greyscale uses its full range across the *measurable* span
   *  instead of bunching all the data at the dark end of a
   *  fixed -5 → 40 scale. Defaults to DB_MAX for callers that
   *  want the legacy absolute-scale rendering (e.g. the PDF
   *  export, where the bar's full range is part of the clinical
   *  reading). */
  dbCeiling: number = DB_MAX,
): void {
  ctx.clearRect(0, 0, size, size)
  const validPoints = points.filter(p => Number.isFinite(p.db))
  if (validPoints.length === 0) return
  if (maxEccentricityDeg <= 0) return
  // Clamp + round the ceiling. Clamp keeps the normalised range
  // sane (below DB_MIN+1 every pixel collapses to the same grey;
  // above DB_MAX gains no extra colour resolution at 8-bit).
  // Round to match what the legend label shows — the unrounded
  // value is a 16-digit float and using two different precisions
  // for the colormap normalisation vs the legend label would mean
  // "the bar's right edge is at 11 dB" but the heatmap treats
  // values up to 11.249 as the same maximum grey. Sub-dB
  // precision in the colormap doesn't buy visible accuracy.
  const effectiveCeiling = Math.min(DB_MAX, Math.max(DB_MIN + 1, Math.round(dbCeiling)))

  const center = size / 2
  const radius = center - CHART_PADDING

  const samples = validPoints.map(p => {
    const rad = (p.meridianDeg * Math.PI) / 180
    const r = (p.eccentricityDeg / maxEccentricityDeg) * radius
    const db = Math.max(DB_MIN, Math.min(DB_MAX, p.db))
    return { x: center + r * Math.cos(rad), y: center - r * Math.sin(rad), db }
  })

  // Clamp rendering to the data's actual extent. Without this the
  // Gaussian-weighted-mean loop at low total weight falls back to the
  // DB_MIN sentinel (-5 dB), so untested space well outside any test
  // point's halo rendered as "deeply blind" — a 10-2 result on a
  // 50°-radius canvas painted the outer ~80% in deep red even though
  // those locations were never measured. Computing a max-data
  // eccentricity (with a small buffer to absorb the Gaussian halo) and
  // skipping pixels beyond it lets the canvas background show through
  // there, making "untested" visually distinct from "blind".
  const dataMaxEccDeg = Math.max(...validPoints.map(p => p.eccentricityDeg))
  const dataExtentPx = ((dataMaxEccDeg + 1.5) / maxEccentricityDeg) * radius
  const dataExtentPx2 = dataExtentPx * dataExtentPx

  // σ controls how far each sample's influence spreads. 9% of radius keeps
  // each cluster's aura roughly the size of the cluster itself — smooth
  // concentric rings around it but tight enough that real asymmetries in
  // the field remain visible. Floor at 8 px so small canvases still
  // produce a visible aura.
  const sigma = Math.max(8, radius * 0.09)
  const twoSigma2 = 2 * sigma * sigma
  // Below this total weight the pixel is so far from any sample that
  // the weighted mean would be dominated by floating-point noise — treat
  // as untested rather than painting a colour.
  const minWeight = 1e-4

  const img = ctx.createImageData(size, size)
  const step = 2
  for (let py = 0; py < size; py += step) {
    for (let px = 0; px < size; px += step) {
      const dx = px - center
      const dy = py - center
      const r2 = dx * dx + dy * dy
      if (r2 > radius * radius) continue
      if (r2 > dataExtentPx2) continue // outside data extent — leave bg

      let wSum = 0
      let wdbSum = 0
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]
        const d2 = (s.x - px) * (s.x - px) + (s.y - py) * (s.y - py)
        const w = Math.exp(-d2 / twoSigma2)
        wSum += w
        wdbSum += w * s.db
      }
      if (wSum < minWeight) continue
      const meanDb = wdbSum / wSum
      const t = (meanDb - DB_MIN) / (effectiveCeiling - DB_MIN)
      const { r, g, b } = sensitivityGreyForT(t)
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

  // Fixation crosshair. White-on-grey works against any greyscale
  // intensity the heatmap renders at the centre.
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(center - 6, center)
  ctx.lineTo(center + 6, center)
  ctx.moveTo(center, center - 6)
  ctx.lineTo(center, center + 6)
  ctx.stroke()
}
