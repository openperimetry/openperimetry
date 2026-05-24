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
): void {
  ctx.clearRect(0, 0, size, size)
  const validPoints = points.filter(p => Number.isFinite(p.db))
  if (validPoints.length === 0) return
  if (maxEccentricityDeg <= 0) return

  const center = size / 2
  const radius = center - CHART_PADDING

  const samples = validPoints.map(p => {
    const rad = (p.meridianDeg * Math.PI) / 180
    const r = (p.eccentricityDeg / maxEccentricityDeg) * radius
    const db = Math.max(DB_MIN, Math.min(DB_MAX, p.db))
    return { x: center + r * Math.cos(rad), y: center - r * Math.sin(rad), db }
  })

  // σ controls how far each sample's influence spreads. 9% of radius keeps
  // each cluster's aura roughly the size of the cluster itself — smooth
  // concentric rings around it but tight enough that real asymmetries in
  // the field remain visible. Floor at 8 px so small canvases still
  // produce a visible aura.
  const sigma = Math.max(8, radius * 0.09)
  const twoSigma2 = 2 * sigma * sigma

  const img = ctx.createImageData(size, size)
  const step = 2
  for (let py = 0; py < size; py += step) {
    for (let px = 0; px < size; px += step) {
      const dx = px - center
      const dy = py - center
      if (dx * dx + dy * dy > radius * radius) continue
      let wSum = 0
      let wdbSum = 0
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]
        const d2 = (s.x - px) * (s.x - px) + (s.y - py) * (s.y - py)
        const w = Math.exp(-d2 / twoSigma2)
        wSum += w
        wdbSum += w * s.db
      }
      const meanDb = wSum > 0 ? wdbSum / wSum : DB_MIN
      const t = (meanDb - DB_MIN) / (DB_MAX - DB_MIN)
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
