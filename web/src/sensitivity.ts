import type { TestPoint } from './types'
import { STIMULI } from './types'

const CHART_PADDING = 40

/** Display range for the sensitivity heatmap.
 *
 *  The measured/derived dB range for real thresholds is roughly 0–35 on a
 *  consumer monitor (0 = patient needs max brightness to detect, higher =
 *  more sensitive, sees dimmer stimuli). We pad both ends for the heatmap
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
 *  encoding is familiar. Returns 0–255 RGB. */
export function jetReverseColor(t: number): { r: number; g: number; b: number } {
  const x = 1 - Math.min(1, Math.max(0, t))
  const r = Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 3))))
  const g = Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 2))))
  const b = Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 1))))
  return { r, g, b }
}

/** Paint a sensitivity heatmap onto the given 2D canvas context.
 *  Uses IDW interpolation inside the disc of `radius` around (center,
 *  center), coloring each cell by `jetReverseColor((db - DB_MIN) / (DB_MAX - DB_MIN))`.
 *  Draws a fixation crosshair at the center. No-op for empty/invalid input. */
export function renderSensitivityToCanvas(
  ctx: CanvasRenderingContext2D,
  points: DbSample[],
  size: number,
  maxEccentricityDeg: number,
  power = 2,
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
    return { x: center + r * Math.cos(rad), y: center - r * Math.sin(rad), db: p.db }
  })

  const img = ctx.createImageData(size, size)
  const step = 2
  for (let py = 0; py < size; py += step) {
    for (let px = 0; px < size; px += step) {
      const dx = px - center
      const dy = py - center
      if (dx * dx + dy * dy > radius * radius) continue
      let num = 0
      let den = 0
      let hit = -1
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]
        const d2 = (s.x - px) * (s.x - px) + (s.y - py) * (s.y - py)
        if (d2 < 1) { hit = i; break }
        const w = 1 / Math.pow(d2, power / 2)
        num += s.db * w
        den += w
      }
      const db = hit >= 0 ? samples[hit].db : num / den
      const t = (db - DB_MIN) / (DB_MAX - DB_MIN)
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
 *  suprathreshold data. For each (meridian, eccentricity) bucket we find
 *  the dimmest stimulus the patient saw and convert its intensity to dB.
 *  Unseen-only locations return DB_MIN (saw nothing). Catch trials are
 *  ignored. This is a *derived* value — not a measured threshold — and the
 *  resolution is coarse (limited to the 5 discrete Goldmann intensities). */
export function deriveDbFromSuprathreshold(points: TestPoint[]): DerivedPoint[] {
  const byLoc = new Map<string, { meridianDeg: number; eccentricityDeg: number; seen: number[]; anyTested: boolean }>()
  for (const p of points) {
    if (p.catchTrial) continue
    const key = `${p.meridianDeg},${p.eccentricityDeg}`
    const bucket = byLoc.get(key) ?? {
      meridianDeg: p.meridianDeg,
      eccentricityDeg: p.eccentricityDeg,
      seen: [],
      anyTested: false,
    }
    bucket.anyTested = true
    if (p.detected) {
      bucket.seen.push(STIMULI[p.stimulus].intensityFrac)
    }
    byLoc.set(key, bucket)
  }
  const out: DerivedPoint[] = []
  for (const b of byLoc.values()) {
    if (!b.anyTested) continue
    const dimmestSeen = b.seen.length > 0 ? Math.min(...b.seen) : null
    const db = dimmestSeen === null ? DB_MIN : opacityToDb(dimmestSeen)
    out.push({ meridianDeg: b.meridianDeg, eccentricityDeg: b.eccentricityDeg, db })
  }
  return out
}
