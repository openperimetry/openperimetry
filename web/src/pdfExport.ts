import jsPDF from 'jspdf'
import type { TestResult, TestPoint, StimulusKey } from './types'
import { STIMULI, ISOPTER_ORDER } from './types'
import { getAllScenarios } from './testFixtures'
import { calcIsopterAreas, clampBoundary } from './isopterCalc'
import { classifyFieldLoss, type FieldSeverity } from './clinicalClassifications'
import { eyeLabelForFilename } from './eyeLabels'
import { APP_NAME, APP_DOMAIN, PDF_HEADER_TAGLINE } from './branding'

// ── Classification logic (matches Interpretation.tsx) ──

interface Classification {
  label: string
  description: string
}

/** PDF-specific descriptions keyed by severity. Labels come from the
 *  shared clinicalClassifications module so both renderers agree on the
 *  clinical grading. */
const PDF_CLASSIFICATION_DESCRIPTIONS: Record<FieldSeverity, string> = {
  'very-severe':
    'Less than ~5% of the testable field is detected. This indicates a tiny central island of vision remaining. Daily activities and mobility are severely affected.',
  severe:
    'Roughly 5-20% of the testable field is detected. This degree of constriction often meets criteria for legal blindness when the central field is <= 20 deg diameter.',
  moderate:
    'Roughly 20-45% of the testable field is detected. Peripheral awareness is reduced. Night vision and navigation in unfamiliar environments may be affected.',
  mild:
    'Roughly 45-70% of the testable field is detected. Some peripheral loss is present but central vision is well preserved.',
  borderline:
    'Roughly 70-85% of the testable field is detected. The field is near-normal with possible early constriction, though this may also reflect normal variation or test conditions.',
  normal:
    'More than ~85% of the testable field is detected - within normal limits for the tested range. A screen-based test cannot cover the full clinical field; a clinical Goldmann test assesses out to 90 deg.',
}

function expectedNormalArea(maxEccentricityDeg: number): number {
  return Math.PI * maxEccentricityDeg * maxEccentricityDeg
}

function classifyField(iii4eArea: number, maxEccentricityDeg: number): Classification {
  const fraction = iii4eArea / expectedNormalArea(maxEccentricityDeg)
  const band = classifyFieldLoss(fraction)
  return { label: band.label, description: PDF_CLASSIFICATION_DESCRIPTIONS[band.severity] }
}

// ── Sensitivity gradient ──

interface Insight {
  label: string
  description: string
}

function analyzeSensitivityGradient(areas: Partial<Record<StimulusKey, number>>): Insight | null {
  const iii4e = areas['III4e']
  const iii2e = areas['III2e']
  if (iii4e == null || iii2e == null || iii4e === 0) return null
  const ratio = iii2e / iii4e
  if (ratio < 0.05) return { label: 'Steep sensitivity drop-off', description: 'The dim stimulus (III2e) is barely seen compared to the bright one (III4e). This suggests a sharp boundary between functioning and non-functioning retina — typical of RP scotomas.' }
  if (ratio < 0.20) return { label: 'Significant sensitivity gradient', description: 'There is a large difference between bright (III4e) and dim (III2e) stimulus detection. The retina in the mid-periphery has reduced sensitivity even where it still detects bright stimuli.' }
  if (ratio < 0.50) return { label: 'Moderate sensitivity gradient', description: 'The sensitivity gradient between bright and dim stimuli is moderate. Some retinal sensitivity loss is present in areas that still detect larger or brighter targets.' }
  return { label: 'Preserved sensitivity', description: 'Dim stimuli are detected across a reasonable portion of the field. Retinal sensitivity is relatively well-preserved where the field is intact.' }
}

// ── Central island ──

function analyzeCentralIsland(areas: Partial<Record<StimulusKey, number>>): Insight | null {
  const i2e = areas['I2e']
  if (i2e == null) return null
  if (i2e < 10) return { label: 'Very small central island', description: 'Fine detail vision (I2e) is limited to less than ~2° radius. Reading and tasks requiring fine acuity may be significantly affected.' }
  if (i2e < 50) return { label: 'Small central island', description: 'Fine detail vision (I2e) is present but limited to a small central area (~2–4° radius). Central acuity may still be functional for reading with appropriate aids.' }
  if (i2e < 200) return { label: 'Moderate central field', description: 'Fine detail vision (I2e) covers a moderate central area. Central function is relatively well preserved.' }
  return { label: 'Good central field', description: 'Fine detail vision (I2e) is present across a healthy central area. Central retinal function appears well preserved.' }
}

// ── Anomaly detection ──

interface Anomaly {
  label: string
  description: string
  severity: 'info' | 'warning' | 'error'
}

function detectAnomalies(points: TestPoint[], areas: Partial<Record<StimulusKey, number>>): Anomaly[] {
  const anomalies: Anomaly[] = []

  for (let i = 0; i < ISOPTER_ORDER.length - 1; i++) {
    const outer = ISOPTER_ORDER[i]
    const inner = ISOPTER_ORDER[i + 1]
    const outerArea = areas[outer]
    const innerArea = areas[inner]
    if (outerArea == null || innerArea == null) continue
    if (innerArea > outerArea * 2.0) {
      anomalies.push({
        label: `${STIMULI[inner].label} isopter much larger than ${STIMULI[outer].label}`,
        description: `The ${STIMULI[inner].label} isopter (${innerArea.toFixed(0)} deg²) is more than double the ${STIMULI[outer].label} isopter (${outerArea.toFixed(0)} deg²). This degree of reversal is unusual and likely indicates a measurement issue.`,
        severity: 'warning',
      })
    }
  }

  const v4e = areas['V4e']
  const i2e = areas['I2e']
  if (v4e != null && i2e != null && i2e > v4e * 1.1) {
    anomalies.push({
      label: 'Innermost isopter larger than outermost',
      description: `The I2e isopter (${i2e.toFixed(0)} deg²) is larger than V4e (${v4e.toFixed(0)} deg²). This is physiologically unlikely and suggests significant testing artifacts.`,
      severity: 'error',
    })
  }

  for (const stim of ISOPTER_ORDER) {
    const detected = points.filter(p => p.stimulus === stim && p.detected)
    if (detected.length < 6) continue
    const eccs = detected.map(p => p.eccentricityDeg)
    const mean = eccs.reduce((s, v) => s + v, 0) / eccs.length
    if (mean < 2) continue
    const variance = eccs.reduce((s, v) => s + (v - mean) ** 2, 0) / eccs.length
    const cv = Math.sqrt(variance) / mean
    if (cv > 0.50) {
      anomalies.push({
        label: `Irregular ${STIMULI[stim].label} isopter shape`,
        description: `The ${STIMULI[stim].label} boundary is highly irregular (CV=${(cv * 100).toFixed(0)}%). Consider retesting for confirmation.`,
        severity: 'warning',
      })
    }
  }

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
          label: 'Marked vertical asymmetry',
          description: `The ${moreAffected} field is significantly more constricted. While some asymmetry is common in RP, marked differences should be discussed with your ophthalmologist.`,
          severity: 'info',
        })
      }
    }
  }

  for (const stim of ISOPTER_ORDER) {
    const stimPoints = points.filter(p => p.stimulus === stim)
    if (stimPoints.length < 4) continue
    const detectedCount = stimPoints.filter(p => p.detected).length
    const rate = detectedCount / stimPoints.length
    if (rate < 0.25) {
      anomalies.push({
        label: `Very low detection for ${STIMULI[stim].label}`,
        description: `Only ${(rate * 100).toFixed(0)}% of ${STIMULI[stim].label} stimuli were detected (${detectedCount}/${stimPoints.length}). This could indicate severe field loss or attention issues.`,
        severity: 'info',
      })
    }
  }

  return anomalies
}

// ── Reliability score (full version from Interpretation.tsx) ──

interface ReliabilityResult {
  score: number
  label: string
  factors: { name: string; penalty: number; detail: string }[]
}

function computeReliability(points: TestPoint[], areas: Partial<Record<StimulusKey, number>>): ReliabilityResult {
  let score = 100
  const factors: ReliabilityResult['factors'] = []

  let mildReversals = 0
  let majorReversals = 0
  for (let i = 0; i < ISOPTER_ORDER.length - 1; i++) {
    const outerArea = areas[ISOPTER_ORDER[i]]
    const innerArea = areas[ISOPTER_ORDER[i + 1]]
    if (outerArea == null || innerArea == null) continue
    if (innerArea > outerArea * 2.0) majorReversals++
    else if (innerArea > outerArea * 1.10) mildReversals++
  }
  if (majorReversals > 0) {
    const penalty = majorReversals * 12
    score -= penalty
    factors.push({ name: 'Isopter ordering', penalty, detail: `${majorReversals} isopter pair(s) dramatically reversed` })
  }
  if (mildReversals > 0) {
    const penalty = mildReversals * 3
    score -= penalty
    factors.push({ name: 'Isopter overlap', penalty, detail: `${mildReversals} adjacent pair(s) overlap slightly` })
  }

  const cvs: number[] = []
  for (const stim of ISOPTER_ORDER) {
    const detected = points.filter(p => p.stimulus === stim && p.detected)
    if (detected.length < 4) continue
    const eccs = detected.map(p => p.eccentricityDeg)
    const mean = eccs.reduce((s, v) => s + v, 0) / eccs.length
    if (mean < 2) continue
    const variance = eccs.reduce((s, v) => s + (v - mean) ** 2, 0) / eccs.length
    cvs.push(Math.sqrt(variance) / mean)
  }
  if (cvs.length > 0) {
    const avgCv = cvs.reduce((s, v) => s + v, 0) / cvs.length
    if (avgCv > 0.30) {
      const penalty = Math.min(25, Math.round((avgCv - 0.30) * 100))
      score -= penalty
      factors.push({ name: 'Shape regularity', penalty, detail: `Average boundary irregularity ${(avgCv * 100).toFixed(0)}%` })
    }
  }

  const totalDetected = points.filter(p => p.detected).length
  if (totalDetected < 30) {
    const penalty = Math.min(20, Math.round((30 - totalDetected) * 1.5))
    score -= penalty
    factors.push({ name: 'Data points', penalty, detail: `Only ${totalDetected} detected points` })
  }

  const uniqueMeridians = new Set(points.filter(p => p.detected).map(p => p.meridianDeg))
  if (uniqueMeridians.size < 8) {
    const penalty = Math.min(15, (8 - uniqueMeridians.size) * 3)
    score -= penalty
    factors.push({ name: 'Meridian coverage', penalty, detail: `Points span only ${uniqueMeridians.size} meridians` })
  }

  const totalPoints = points.length
  const overallRate = totalPoints > 0 ? totalDetected / totalPoints : 1
  if (overallRate < 0.40) {
    const penalty = Math.min(15, Math.round((0.40 - overallRate) * 50))
    score -= penalty
    factors.push({ name: 'Detection rate', penalty, detail: `Overall detection rate ${(overallRate * 100).toFixed(0)}%` })
  }

  const meridianStimPairs = new Map<string, number>()
  for (const p of points) {
    const key = `${p.stimulus}-${p.meridianDeg}-${p.detected}`
    meridianStimPairs.set(key, (meridianStimPairs.get(key) ?? 0) + 1)
  }
  const multiReadings = [...meridianStimPairs.values()].filter(c => c > 1).length
  const retestRatio = meridianStimPairs.size > 0 ? multiReadings / meridianStimPairs.size : 0
  if (retestRatio > 0.30) {
    const penalty = Math.min(10, Math.round((retestRatio - 0.30) * 30))
    score -= penalty
    factors.push({ name: 'Retest rate', penalty, detail: `${(retestRatio * 100).toFixed(0)}% of positions needed re-testing` })
  }

  score = Math.max(0, Math.min(100, score))
  const label = score >= 85 ? 'High' : score >= 65 ? 'Moderate' : score >= 40 ? 'Low' : 'Very low'

  return { score, label, factors }
}

// ── Render radar as SVG image (reuses VisualFieldMap logic) ──

function polarToXY(eccDeg: number, meridianDeg: number, center: number, scale: number): [number, number] {
  const r = eccDeg * scale
  const theta = (meridianDeg * Math.PI) / 180
  return [center + r * Math.cos(theta), center - r * Math.sin(theta)]
}

function smoothClosedPath(pts: [number, number][]): string {
  const n = pts.length
  if (n < 3) return ''
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`
  }
  return d + ' Z'
}

function binBoundaryPoints(allDetected: TestPoint[], binSizeDeg: number = 5): { meridianDeg: number; eccentricityDeg: number }[] {
  if (allDetected.length < 3) return []
  const numBins = Math.round(360 / binSizeDeg)
  const bins: (number | null)[] = new Array(numBins).fill(null)
  for (const p of allDetected) {
    const bin = Math.round(p.meridianDeg / binSizeDeg) % numBins
    if (bins[bin] === null || p.eccentricityDeg > bins[bin]!) bins[bin] = p.eccentricityDeg
  }
  // Interpolate gaps
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < numBins; i++) {
      if (bins[i] !== null) continue
      let prev: number | null = null, next: number | null = null
      for (let d = 1; d <= numBins / 2; d++) {
        if (prev === null && bins[(i - d + numBins) % numBins] !== null) prev = bins[(i - d + numBins) % numBins]
        if (next === null && bins[(i + d) % numBins] !== null) next = bins[(i + d) % numBins]
        if (prev !== null && next !== null) break
      }
      if (prev !== null && next !== null) bins[i] = (prev + next) / 2
    }
  }
  return bins.map((ecc, i) => ({ meridianDeg: i * binSizeDeg, eccentricityDeg: ecc ?? 0 })).filter(p => p.eccentricityDeg > 0)
}

function computeIsoptersSVG(
  grouped: Partial<Record<StimulusKey, TestPoint[]>>,
  center: number,
  scale: number,
): { key: StimulusKey; isopterIdx: number; svgPts: [number, number][]; isScattered: boolean }[] {
  const results: { key: StimulusKey; isopterIdx: number; svgPts: [number, number][]; isScattered: boolean }[] = []
  let prevBoundary: { meridianDeg: number; eccentricityDeg: number }[] | null = null

  for (let isopterIdx = 0; isopterIdx < ISOPTER_ORDER.length; isopterIdx++) {
    const key = ISOPTER_ORDER[isopterIdx]
    const pts = grouped[key]
    if (!pts) continue
    const allDetected = pts.filter(p => p.detected)
    if (allDetected.length < 3) continue
    const isScattered = allDetected.length > 20
    const binSize = isScattered ? 5 : (allDetected.length <= 12 ? 30 : 15)
    let boundary = binBoundaryPoints(allDetected, binSize)
    if (boundary.length < 3) continue
    // Clamp the current (dimmer) boundary to not exceed the previous
    // (brighter) one. Uses meridian-aware sampling instead of index equality
    // so a 15°-binned inner isopter correctly nests inside a 30°-binned
    // outer one.
    if (prevBoundary) {
      boundary = clampBoundary(boundary, prevBoundary)
    }
    const smoothWeight = 0.22
    const selfWeight = 1 - 2 * smoothWeight
    let smoothed = [...boundary]
    smoothed = smoothed.map((p, i) => {
      const n = smoothed.length
      const prev = smoothed[(i - 1 + n) % n]
      const next = smoothed[(i + 1) % n]
      const neighborAvg = (prev.eccentricityDeg + next.eccentricityDeg) / 2
      const diff = Math.abs(p.eccentricityDeg - neighborAvg)
      const threshold = Math.max(2, neighborAvg * 0.3)
      if (diff > threshold) return { ...p, eccentricityDeg: neighborAvg * 0.65 + p.eccentricityDeg * 0.35 }
      return p
    })
    const numPasses = isScattered ? 3 : (boundary.length <= 24 ? 3 : 1)
    for (let pass = 0; pass < numPasses; pass++) {
      smoothed = smoothed.map((p, i) => {
        const n = smoothed.length
        const prev = smoothed[(i - 1 + n) % n]
        const next = smoothed[(i + 1) % n]
        return { ...p, eccentricityDeg: prev.eccentricityDeg * smoothWeight + p.eccentricityDeg * selfWeight + next.eccentricityDeg * smoothWeight }
      })
    }
    prevBoundary = smoothed
    const svgPts = smoothed.map(p => polarToXY(p.eccentricityDeg, p.meridianDeg, center, scale) as [number, number])
    results.push({ key, isopterIdx, svgPts, isScattered })
  }
  return results
}

/** Build SVG string matching VisualFieldMap and render to data URL */
async function renderRadarImage(result: TestResult, sizePx: number): Promise<string> {
  const PADDING = 40
  const center = sizePx / 2
  const radius = center - PADDING
  const maxEcc = result.calibration.maxEccentricityDeg
  const scale = radius / maxEcc
  const ringStep = maxEcc <= 30 ? 5 : 10
  const eye = result.eye === 'left' ? 'left' : 'right'

  const grouped: Partial<Record<StimulusKey, TestPoint[]>> = {}
  for (const p of result.points) {
    if (!grouped[p.stimulus]) grouped[p.stimulus] = []
    grouped[p.stimulus]!.push(p)
  }

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sizePx} ${sizePx}" width="${sizePx}" height="${sizePx}">`
  svg += `<rect width="${sizePx}" height="${sizePx}" fill="#0f172a" rx="12"/>`

  // Concentric rings
  for (let deg = ringStep; deg < maxEcc; deg += ringStep) {
    svg += `<circle cx="${center}" cy="${center}" r="${deg * scale}" fill="none" stroke="#334155" stroke-width="0.5"/>`
  }

  // Ring labels
  const rings = Array.from({ length: Math.floor(maxEcc / ringStep) }, (_, i) => (i + 1) * ringStep)
  for (const deg of rings.filter((_, i) => i % 2 === 1 || rings.length <= 6)) {
    svg += `<text x="${center + deg * scale + 2}" y="${center - 3}" fill="#64748b" font-size="9" font-family="sans-serif">${deg}°</text>`
  }

  // Meridian lines
  for (let m = 0; m < 360; m += 30) {
    const [x, y] = polarToXY(maxEcc, m, center, scale)
    svg += `<line x1="${center}" y1="${center}" x2="${x}" y2="${y}" stroke="#334155" stroke-width="0.5"/>`
  }

  // Axis labels
  svg += `<text x="${sizePx - PADDING + 4}" y="${center + 4}" fill="#94a3b8" font-size="11" font-family="sans-serif">${eye === 'right' ? 'T' : 'N'}</text>`
  svg += `<text x="4" y="${center + 4}" fill="#94a3b8" font-size="11" font-family="sans-serif">${eye === 'right' ? 'N' : 'T'}</text>`
  svg += `<text x="${center - 3}" y="${PADDING - 6}" fill="#94a3b8" font-size="11" font-family="sans-serif">S</text>`
  svg += `<text x="${center - 3}" y="${sizePx - PADDING + 14}" fill="#94a3b8" font-size="11" font-family="sans-serif">I</text>`

  // Blind spot
  const bsMeridian = eye === 'right' ? 0 : 180
  const [bsX, bsY] = polarToXY(15, bsMeridian - 2, center, scale)
  svg += `<ellipse cx="${bsX}" cy="${bsY}" rx="${3.5 * scale}" ry="${2.5 * scale}" fill="#1e293b" stroke="#475569" stroke-width="0.5" stroke-dasharray="2,2"/>`

  // Isopters
  const dashPatterns = ['', '', '6,3', '3,3', '1,3']
  const strokeWidths = [2, 1.8, 1.5, 1.5, 1.3]
  const fillOpacities = [0.10, 0.08, 0.06, 0.05, 0.04]

  for (const { key, isopterIdx, svgPts, isScattered } of computeIsoptersSVG(grouped, center, scale)) {
    const color = STIMULI[key].color
    const path = smoothClosedPath(svgPts)
    svg += `<path d="${path}" fill="${color}" fill-opacity="${fillOpacities[isopterIdx]}" stroke="none"/>`
    svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="${strokeWidths[isopterIdx]}"${dashPatterns[isopterIdx] ? ` stroke-dasharray="${dashPatterns[isopterIdx]}"` : ''}/>`
    if (!isScattered) {
      for (const pt of svgPts) {
        svg += `<circle cx="${pt[0]}" cy="${pt[1]}" r="2.5" fill="${color}"/>`
      }
    }
  }

  // Undetected points
  for (const p of result.points.filter(p => !p.detected)) {
    const [x, y] = polarToXY(p.eccentricityDeg, p.meridianDeg, center, scale)
    svg += `<circle cx="${x}" cy="${y}" r="1.5" fill="#ef4444" opacity="0.4"/>`
  }

  // Fixation dot
  svg += `<circle cx="${center}" cy="${center}" r="2" fill="#fbbf24"/>`
  svg += '</svg>'

  // Render SVG to canvas → data URL
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  return new Promise<string>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = sizePx * 2  // 2x for sharpness
      canvas.height = sizePx * 2
      const ctx = canvas.getContext('2d')!
      ctx.scale(2, 2)
      ctx.drawImage(img, 0, 0, sizePx, sizePx)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = reject
    img.src = url
  })
}

// ── PDF text helpers ──

/** Replace Unicode characters that break jsPDF's default font encoding */
function pdfSafe(text: string): string {
  return text
    .replace(/°/g, ' deg')
    .replace(/²/g, '2')
    .replace(/≤/g, '<=')
    .replace(/≥/g, '>=')
    .replace(/—/g, ' - ')
    .replace(/–/g, '-')
}

function drawSection(doc: jsPDF, title: string, y: number, margin: number): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(0, 0, 0)
  doc.text(title, margin, y)
  return y + 5
}

function drawWrappedText(doc: jsPDF, text: string, x: number, y: number, maxW: number, fontSize = 8): number {
  doc.setFontSize(fontSize)
  const lines: string[] = doc.splitTextToSize(pdfSafe(text), maxW)
  doc.text(lines, x, y)
  return y + lines.length * (fontSize * 0.42) + 1
}

// ── Main export function ──

export async function exportResultPDF(result: TestResult, options?: {
  isDemo?: boolean
  visionSimImage?: string
  /** Render as a binocular report with per-eye radar maps. Required when
   *  rightEyePoints / leftEyePoints are provided. */
  binocular?: boolean
  /** Per-eye points for binocular tests — enables per-eye radar maps */
  rightEyePoints?: TestPoint[]
  leftEyePoints?: TestPoint[]
}): Promise<void> {
  const isDemo = options?.isDemo ?? false
  const visionSimImage = options?.visionSimImage
  const isBinocular = options?.binocular ?? false
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 15
  let y = margin

  // ═══════════════════════════════════════
  // PAGE 1: Test Results & Visual Field Map
  // ═══════════════════════════════════════

  // Demo banner
  if (isDemo) {
    doc.setFillColor(254, 243, 199) // amber-100
    doc.rect(0, 0, pageW, 10, 'F')
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(146, 64, 14) // amber-800
    doc.text('CLINICAL DEMO - Simulated scenario, not from a real test', pageW / 2, 6.5, { align: 'center' })
    y += 8
  }

  // Header
  doc.setFontSize(18)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(0, 0, 0)
  doc.text('Visual Field Test Report', margin, y)
  y += 7

  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(120, 120, 120)
  doc.text(PDF_HEADER_TAGLINE, margin, y)
  y += 5

  // Horizontal rule
  doc.setDrawColor(200, 200, 200)
  doc.setLineWidth(0.3)
  doc.line(margin, y, pageW - margin, y)
  y += 6

  // Test info
  y = drawSection(doc, 'Test Information', y, margin)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  const eyeLabel = isBinocular ? 'OU (Both Eyes)' : result.eye === 'right' ? 'OD (Right Eye)' : 'OS (Left Eye)'
  const testDate = new Date(result.date)
  const dateStr = testDate.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
  const timeStr = testDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  const info = [
    ['Eye tested:', eyeLabel],
    ['Date:', `${dateStr} at ${timeStr}`],
    ['Viewing distance:', `${result.calibration.viewingDistanceCm} cm`],
    ['Max eccentricity:', `${result.calibration.maxEccentricityDeg.toFixed(1)} deg`],
    ['Total test points:', `${result.points.length}`],
    ['Detected points:', `${result.points.filter(p => p.detected).length}`],
  ]

  for (const [label, value] of info) {
    doc.setTextColor(100, 100, 100)
    doc.text(label, margin, y)
    doc.setTextColor(0, 0, 0)
    doc.text(value, margin + 40, y)
    y += 4.5
  }
  y += 4

  // Isopter areas table
  y = drawSection(doc, 'Isopter Areas', y, margin)

  doc.setFillColor(245, 245, 245)
  doc.rect(margin, y - 3.5, pageW - 2 * margin, 5, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(60, 60, 60)
  doc.text('Isopter', margin + 2, y)
  doc.text('Size', margin + 30, y)
  doc.text('Intensity', margin + 55, y)
  doc.text('Area (deg2)', margin + 85, y)
  doc.text('Equiv. radius', margin + 115, y)
  doc.text('Points', margin + 145, y)
  y += 5

  doc.setFont('helvetica', 'normal')
  for (const stim of ISOPTER_ORDER) {
    const area = result.isopterAreas[stim]
    const pts = result.points.filter(p => p.stimulus === stim)
    const detected = pts.filter(p => p.detected).length
    const def = STIMULI[stim]

    doc.setTextColor(0, 0, 0)
    doc.text(def.label, margin + 2, y)
    doc.setTextColor(80, 80, 80)
    doc.text(`${def.sizeDeg.toFixed(2)} deg`, margin + 30, y)
    doc.text(`${(def.intensityFrac * 100).toFixed(0)}%`, margin + 55, y)
    doc.text(area != null ? area.toFixed(0) : '-', margin + 85, y)
    doc.text(area != null ? `~${Math.sqrt(area / Math.PI).toFixed(1)} deg` : '-', margin + 115, y)
    doc.text(`${detected}/${pts.length}`, margin + 145, y)
    y += 4.5
  }
  y += 6

  // Visual field map — rendered as image matching on-screen appearance
  y = drawSection(doc, isBinocular ? 'Combined Visual Field Map (OU)' : 'Visual Field Map', y, margin)
  y += 2

  const mapSizeMm = 85
  const radarImg = await renderRadarImage(result, 800)
  const mapX = (pageW - mapSizeMm) / 2
  doc.addImage(radarImg, 'PNG', mapX, y, mapSizeMm, mapSizeMm)
  y += mapSizeMm + 4

  // Legend below map
  doc.setFontSize(7)
  const legendColors: Record<StimulusKey, string> = { 'V4e': '#60a5fa', 'III4e': '#34d399', 'III2e': '#a78bfa', 'I4e': '#fb923c', 'I2e': '#f472b6' }
  for (let i = 0; i < ISOPTER_ORDER.length; i++) {
    const stim = ISOPTER_ORDER[i]
    const hex = legendColors[stim]
    const cr = parseInt(hex.slice(1, 3), 16)
    const cg = parseInt(hex.slice(3, 5), 16)
    const cb = parseInt(hex.slice(5, 7), 16)
    const lx = margin + i * 33
    doc.setFillColor(cr, cg, cb)
    doc.circle(lx + 1.5, y - 0.5, 1.5, 'F')
    doc.setTextColor(80, 80, 80)
    doc.setFont('helvetica', 'normal')
    doc.text(STIMULI[stim].label, lx + 4, y)
  }
  y += 6

  // Per-eye radar maps for binocular tests
  if (isBinocular && (options?.rightEyePoints || options?.leftEyePoints)) {
    const perEyeSize = 65
    const perEyeGap = 10
    const totalW = perEyeSize * 2 + perEyeGap
    const startX = (pageW - totalW) / 2

    // Check if enough space, otherwise new page
    if (y + perEyeSize + 15 > pageH - 15) {
      doc.addPage()
      y = margin
    }

    y = drawSection(doc, 'Per-Eye Visual Field Maps', y, margin)
    y += 2

    const renderPerEye = async (eyePoints: TestPoint[], eye: 'right' | 'left', xPos: number) => {
      const perEyeResult: TestResult = { ...result, eye, points: eyePoints }
      const img = await renderRadarImage(perEyeResult, 600)
      doc.addImage(img, 'PNG', xPos, y, perEyeSize, perEyeSize)
      doc.setFontSize(8)
      doc.setTextColor(80, 80, 80)
      doc.setFont('helvetica', 'bold')
      const label = eye === 'right' ? 'OD (Right Eye)' : 'OS (Left Eye)'
      doc.text(label, xPos + perEyeSize / 2, y + perEyeSize + 4, { align: 'center' })
    }

    const perEyePromises: Promise<void>[] = []
    if (options?.rightEyePoints) {
      perEyePromises.push(renderPerEye(options.rightEyePoints, 'right', startX))
    }
    if (options?.leftEyePoints) {
      perEyePromises.push(renderPerEye(options.leftEyePoints, 'left', startX + perEyeSize + perEyeGap))
    }
    await Promise.all(perEyePromises)
    y += perEyeSize + 8
  }

  // Vision simulation (if provided)
  if (visionSimImage) {
    // Check if enough space on current page, otherwise add new page
    const simH = 55
    if (y + simH + 20 > pageH - 15) {
      doc.addPage()
      y = margin
    }
    y = drawSection(doc, 'Vision Simulation', y, margin)
    y += 2
    const simW = 80
    const simX = (pageW - simW) / 2
    doc.addImage(visionSimImage, 'PNG', simX, y, simW, simH)
    y += simH + 3
    doc.setFontSize(7)
    doc.setTextColor(120, 120, 120)
    doc.setFont('helvetica', 'italic')
    doc.text('Approximate simulation of how visual field loss may affect everyday vision.', pageW / 2, y, { align: 'center' })
    doc.setFont('helvetica', 'normal')
    y += 5
  }

  // Quick summary on page 1
  const iii4eArea = result.isopterAreas['III4e']
  const maxEccDeg = result.calibration.maxEccentricityDeg
  const expectedArea = expectedNormalArea(maxEccDeg)
  if (iii4eArea != null) {
    const classification = classifyField(iii4eArea, maxEccDeg)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(0, 0, 0)
    doc.text(`Classification: ${classification.label}`, margin, y)
    y += 4
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(100, 100, 100)
    doc.text(pdfSafe(`III4e isopter: ${iii4eArea.toFixed(0)} deg² (~${((iii4eArea / expectedArea) * 100).toFixed(0)}% of testable area, equiv. radius ~${Math.sqrt(iii4eArea / Math.PI).toFixed(1)}°)`), margin, y)
    y += 5
  }

  const reliability = computeReliability(result.points, result.isopterAreas)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(80, 80, 80)
  doc.text(`Test reliability: ${reliability.score}/100 (${reliability.label})`, margin, y)

  // Page 1 footer
  doc.setFontSize(7)
  doc.setTextColor(160, 160, 160)
  doc.text(`Report generated: ${new Date().toLocaleString('en-GB')}  |  ${APP_DOMAIN}  |  Page 1 of 2`, margin, pageH - 10)

  // ═══════════════════════════════════════
  // PAGE 2: Full Interpretation
  // ═══════════════════════════════════════

  doc.addPage()
  y = margin

  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(0, 0, 0)
  doc.text('Detailed Interpretation', margin, y)
  y += 5

  doc.setDrawColor(200, 200, 200)
  doc.setLineWidth(0.3)
  doc.line(margin, y, pageW - margin, y)
  y += 6

  const contentW = pageW - 2 * margin

  // ── Reliability score ──
  y = drawSection(doc, 'Test Reliability', y, margin)

  // Score bar
  doc.setFillColor(229, 231, 235) // gray bg
  doc.rect(margin, y, 60, 3, 'F')
  const barColor: [number, number, number] = reliability.score >= 85 ? [74, 222, 128] : reliability.score >= 65 ? [250, 204, 21] : reliability.score >= 40 ? [251, 146, 60] : [248, 113, 113]
  doc.setFillColor(...barColor)
  doc.rect(margin, y, 60 * (reliability.score / 100), 3, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(0, 0, 0)
  doc.text(`${reliability.score}/100 - ${reliability.label}`, margin + 65, y + 2.5)
  y += 6

  if (reliability.factors.length > 0) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    for (const f of reliability.factors) {
      doc.setTextColor(220, 38, 38) // red
      doc.text(`-${f.penalty}`, margin + 2, y)
      doc.setTextColor(100, 100, 100)
      doc.text(f.detail, margin + 12, y)
      y += 3.5
    }
  } else {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(120, 120, 120)
    doc.text('No reliability issues detected.', margin + 2, y)
    y += 4
  }
  y += 4

  // ── Field classification ──
  if (iii4eArea != null) {
    const classification = classifyField(iii4eArea, maxEccDeg)
    y = drawSection(doc, 'Field Classification', y, margin)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(0, 0, 0)
    doc.text(classification.label, margin + 2, y)
    y += 4

    doc.setFont('helvetica', 'normal')
    doc.setTextColor(60, 60, 60)
    y = drawWrappedText(doc, classification.description, margin + 2, y, contentW - 4, 8)

    doc.setTextColor(120, 120, 120)
    y = drawWrappedText(doc, `III4e isopter: ${iii4eArea.toFixed(0)} deg2 (~${((iii4eArea / expectedArea) * 100).toFixed(0)}% of testable area, equiv. radius ~${Math.sqrt(iii4eArea / Math.PI).toFixed(1)} deg)`, margin + 2, y, contentW - 4, 7)
    y += 4
  }

  // ── Sensitivity gradient ──
  const gradient = analyzeSensitivityGradient(result.isopterAreas)
  if (gradient) {
    y = drawSection(doc, 'Sensitivity Gradient', y, margin)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(0, 0, 0)
    doc.text(gradient.label, margin + 2, y)
    y += 4

    doc.setFont('helvetica', 'normal')
    doc.setTextColor(60, 60, 60)
    y = drawWrappedText(doc, gradient.description, margin + 2, y, contentW - 4, 8)

    const iii2e = result.isopterAreas['III2e']
    if (iii4eArea != null && iii2e != null) {
      doc.setFontSize(7)
      doc.setTextColor(120, 120, 120)
      doc.text(`III2e/III4e ratio: ${((iii2e / iii4eArea) * 100).toFixed(0)}%`, margin + 2, y)
      y += 3
    }
    y += 4
  }

  // ── Central island ──
  const centralIsland = analyzeCentralIsland(result.isopterAreas)
  if (centralIsland) {
    y = drawSection(doc, 'Central Island Analysis', y, margin)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(0, 0, 0)
    doc.text(centralIsland.label, margin + 2, y)
    y += 4

    doc.setFont('helvetica', 'normal')
    doc.setTextColor(60, 60, 60)
    y = drawWrappedText(doc, centralIsland.description, margin + 2, y, contentW - 4, 8)

    const i2eArea = result.isopterAreas['I2e']
    if (i2eArea != null) {
      doc.setFontSize(7)
      doc.setTextColor(120, 120, 120)
      doc.text(pdfSafe(`I2e area: ${i2eArea.toFixed(0)} deg2 (equiv. radius ~${Math.sqrt(i2eArea / Math.PI).toFixed(1)} deg)`), margin + 2, y)
      y += 3
    }
    y += 4
  }

  // ── Anomalies ──
  const anomalies = detectAnomalies(result.points, result.isopterAreas)
  if (anomalies.length > 0) {
    y = drawSection(doc, 'Anomalies Detected', y, margin)

    for (const a of anomalies) {
      // Check page overflow
      if (y > pageH - 40) {
        doc.addPage()
        y = margin
      }

      doc.setFont('helvetica', 'bold')
      const anomalyColor: [number, number, number] = a.severity === 'error' ? [180, 30, 30] : a.severity === 'warning' ? [160, 100, 30] : [60, 60, 180]
      doc.setTextColor(...anomalyColor)
      y = drawWrappedText(doc, a.label, margin + 2, y, contentW - 4, 8.5)

      doc.setFont('helvetica', 'normal')
      doc.setTextColor(80, 80, 80)
      y = drawWrappedText(doc, a.description, margin + 5, y, contentW - 7, 7.5)
      y += 2
    }
    y += 2
  }

  // ── Clinical comparison ──
  {
    const scenarios = getAllScenarios()
    const scenarioAreas = scenarios.map(s => ({ ...s, areas: calcIsopterAreas(s.points) }))

    // Find closest match based on III4e (or V4e fallback)
    const userKey: StimulusKey = result.isopterAreas['III4e'] != null ? 'III4e' : 'V4e'
    const userArea = result.isopterAreas[userKey]
    let bestIdx = 0
    if (userArea != null) {
      let bestDist = Infinity
      scenarioAreas.forEach((s, i) => {
        const sArea = s.areas[userKey]
        if (sArea != null) {
          const dist = Math.abs(sArea - userArea)
          if (dist < bestDist) { bestDist = dist; bestIdx = i }
        }
      })
    }
    const closest = scenarioAreas[bestIdx]

    // Ensure enough space for comparison section
    if (y + 50 > pageH - 15) {
      doc.addPage()
      y = margin
    }

    y = drawSection(doc, 'Clinical Comparison', y, margin)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(80, 80, 80)
    doc.text(`Closest match: ${closest.label} (${closest.severity})`, margin + 2, y)
    y += 3.5
    y = drawWrappedText(doc, closest.description, margin + 2, y, contentW - 4, 7.5)
    y += 2

    // Comparison table header
    doc.setFillColor(245, 245, 245)
    doc.rect(margin, y - 3.5, contentW, 5, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    doc.setTextColor(60, 60, 60)
    doc.text('Isopter', margin + 2, y)
    doc.text('Your result', margin + 50, y)
    doc.text(closest.label, margin + 90, y)
    doc.text('Diff', margin + 130, y)
    y += 5

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    for (const key of ISOPTER_ORDER) {
      const uArea = result.isopterAreas[key]
      const rArea = closest.areas[key]
      if (uArea == null && rArea == null) continue

      const diff = (uArea != null && rArea != null) ? uArea - rArea : null

      doc.setTextColor(0, 0, 0)
      doc.text(STIMULI[key].label, margin + 2, y)
      doc.setTextColor(80, 80, 80)
      doc.text(uArea != null ? `${uArea.toFixed(0)} deg2` : '-', margin + 50, y)
      doc.text(rArea != null ? `${rArea.toFixed(0)} deg2` : '-', margin + 90, y)

      if (diff != null) {
        doc.setTextColor(diff > 0 ? 34 : diff < -100 ? 220 : 160, diff > 0 ? 197 : diff < -100 ? 38 : 130, diff > 0 ? 94 : 38)
        doc.text(`${diff > 0 ? '+' : ''}${diff.toFixed(0)} deg2`, margin + 130, y)
      } else {
        doc.setTextColor(150, 150, 150)
        doc.text('-', margin + 130, y)
      }
      y += 4
    }
    y += 4
  }

  // ── Disclaimer ──
  // Ensure enough space
  if (y > pageH - 35) {
    doc.addPage()
    y = margin
  }

  doc.setDrawColor(200, 200, 200)
  doc.line(margin, y, pageW - margin, y)
  y += 4

  doc.setFontSize(7)
  doc.setTextColor(140, 140, 140)
  doc.setFont('helvetica', 'italic')
  const disclaimer = doc.splitTextToSize(
    'DISCLAIMER: This report is generated from a screen-based self-check and is intended for self-monitoring purposes only. ' +
    'It is not a clinical diagnosis. Isopter areas may differ from clinical Goldmann perimetry due to screen limitations, ' +
    'calibration differences, and the absence of controlled testing conditions. Always consult your ophthalmologist for clinical assessment. ' +
    `Generated by ${APP_DOMAIN} ${APP_NAME} self-check.`,
    contentW,
  )
  doc.text(disclaimer, margin, y)

  // Page 2 footer
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(160, 160, 160)
  doc.text(`Report generated: ${new Date().toLocaleString('en-GB')}  |  ${APP_DOMAIN}  |  Page 2 of 2`, margin, pageH - 10)

  // Save
  const filename = `visual-field-${eyeLabelForFilename(result.eye, isBinocular)}-${result.date.slice(0, 10)}.pdf`
  doc.save(filename)
}
