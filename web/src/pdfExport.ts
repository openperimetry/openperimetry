import jsPDF from 'jspdf'
import type { TestResult, TestPoint, StimulusKey, CalibrationData } from './types'
import { STIMULI, ISOPTER_ORDER, isGoldmannResult } from './types'
import { getAllScenarios } from './testFixtures'
import { calcIsopterAreas } from './isopterCalc'
import { classifyFieldLoss, expectedNormalArea, type FieldSeverity } from './clinicalClassifications'
import {
  analyzeSensitivityGradient,
  analyzeCentralIsland,
  detectFieldPatterns,
  detectRPFindings,
  detectAnomalies,
  type Tone,
  type AnomalyIcon,
} from './fieldAnalysis'
import { eyeLabelForFilename } from './eyeLabels'
import { APP_NAME, APP_DOMAIN, PDF_HEADER_TAGLINE } from './branding'
import { computeReliability } from './reliabilityScore'
import { computeReliabilityIndices } from './reliabilityIndices'
import { RELIABILITY_REFERENCE_RANGES } from './testDefaults'
import { polarToXY, smoothClosedPath, computeIsopters, computeScreenBoundary } from './isopterRender'
import { renderSensitivityToCanvas } from './sensitivity'

// ── Classification logic ──
// Thresholds, bands and the gradient / central-island / RP / anomaly
// analyses live in ./clinicalClassifications and ./fieldAnalysis so the
// PDF and the in-app Interpretation panel cannot disagree. This file
// just maps the shared outputs to jsPDF-specific colours.

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

function classifyField(
  iii4eArea: number,
  maxEccentricityDeg: number,
  calibration?: CalibrationData,
): Classification {
  const fraction = iii4eArea / expectedNormalArea(maxEccentricityDeg, calibration)
  const band = classifyFieldLoss(fraction)
  return { label: band.label, description: PDF_CLASSIFICATION_DESCRIPTIONS[band.severity] }
}

/** jsPDF RGB triples per tone emitted by fieldAnalysis.ts. The in-app
 *  renderer has a parallel Tailwind mapping — both stay in sync because
 *  the shared module emits a tone key, not a colour. */
const TONE_RGB: Record<Tone, [number, number, number]> = {
  critical: [220, 38, 38],   // red-600
  warning: [194, 65, 12],    // orange-700
  caution: [161, 98, 7],     // yellow-700
  info: [29, 78, 216],       // blue-700
  ok: [22, 101, 52],         // green-700
  muted: [100, 116, 139],    // slate-500
}

/** Icon glyph shown in front of anomaly labels. Keeps the 3-band ℹ/⚠/✕
 *  cue the PDF used to carry, but no longer duplicates colour state
 *  because colour is supplied by `TONE_RGB[anomaly.tone]`. */
const ANOMALY_GLYPH: Record<AnomalyIcon, string> = {
  info: 'i ',
  warning: '! ',
  error: 'x ',
}

// Reliability scoring + isopter rendering are now shared with the in-app
// renderer via ./reliabilityScore and ./isopterRender so the PDF and the
// on-screen results page can never disagree about the score or contour
// shape for a given test.

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

  // Screen boundary + "not tested beyond screen" mask. Shared with the
  // on-screen VisualFieldMap via computeScreenBoundary so the two
  // surfaces paint the same untested region.
  const boundary = computeScreenBoundary(result.calibration, center, scale, radius)
  if (boundary) {
    svg += `<path d="${boundary.maskPath}" fill="#475569" fill-opacity="0.22" fill-rule="evenodd"/>`
    svg += `<polygon points="${boundary.polygonStr}" fill="none" stroke="#3b82f6" stroke-width="1" stroke-opacity="0.45" stroke-dasharray="4,3"/>`
    svg += `<text x="${center}" y="${PADDING - 22}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="sans-serif" opacity="0.7">not tested (beyond screen)</text>`
  }

  // Blind spot
  const bsMeridian = eye === 'right' ? 0 : 180
  const [bsX, bsY] = polarToXY(15, bsMeridian - 2, center, scale)
  svg += `<ellipse cx="${bsX}" cy="${bsY}" rx="${3.5 * scale}" ry="${2.5 * scale}" fill="#1e293b" stroke="#475569" stroke-width="0.5" stroke-dasharray="2,2"/>`

  // Isopters
  const dashPatterns = ['', '', '6,3', '3,3', '1,3']
  const strokeWidths = [2, 1.8, 1.5, 1.5, 1.3]
  const fillOpacities = [0.10, 0.08, 0.06, 0.05, 0.04]

  for (const { key, isopterIdx, svgPts, isScattered } of computeIsopters(grouped, center, scale)) {
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

/** Render the measured sensitivity heatmap (threshold-mode only) to a
 *  PNG data URL. Returns null when the result has no per-location
 *  thresholdDb (Goldmann or legacy suprathreshold static) — caller
 *  should skip the sensitivity section in that case. */
async function renderSensitivityImage(result: TestResult, sizePx: number): Promise<string | null> {
  const measured = result.points
    .filter(p => p.thresholdDb != null && !p.catchTrial)
    .map(p => ({
      meridianDeg: p.meridianDeg,
      eccentricityDeg: p.eccentricityDeg,
      db: p.thresholdDb!,
    }))
  if (measured.length === 0) return null

  const src = document.createElement('canvas')
  src.width = sizePx
  src.height = sizePx
  const srcCtx = src.getContext('2d')!
  srcCtx.fillStyle = '#0f172a'
  srcCtx.fillRect(0, 0, sizePx, sizePx)

  renderSensitivityToCanvas(
    srcCtx,
    measured,
    sizePx,
    result.calibration.maxEccentricityDeg,
  )

  const dst = document.createElement('canvas')
  dst.width = sizePx * 2
  dst.height = sizePx * 2
  const dstCtx = dst.getContext('2d')!
  dstCtx.drawImage(src, 0, 0, sizePx * 2, sizePx * 2)
  return dst.toDataURL('image/png')
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

export type PDFExportOptions = {
  isDemo?: boolean
  visionSimImage?: string
  /** Render as a binocular report with per-eye radar maps. Required when
   *  rightEyePoints / leftEyePoints are provided. */
  binocular?: boolean
  /** Per-eye points for binocular tests — enables per-eye radar maps */
  rightEyePoints?: TestPoint[]
  leftEyePoints?: TestPoint[]
}

export async function exportResultPDF(result: TestResult, options?: PDFExportOptions): Promise<void> {
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

  const reliabilityIdx = computeReliabilityIndices(result)
  if (reliabilityIdx.fa) {
    const faRange = RELIABILITY_REFERENCE_RANGES.faPercent
    info.push([
      'Fixation accuracy (FA):',
      `${reliabilityIdx.fa.correct}/${reliabilityIdx.fa.presented} (${reliabilityIdx.fa.percent.toFixed(0)}% — ${reliabilityIdx.fa.bandLabel}; normal ${faRange.min}–${faRange.max}%)`,
    ])
    if (reliabilityIdx.fprr) {
      const fprrRange = RELIABILITY_REFERENCE_RANGES.fprrPercent
      info.push([
        'False-positive response rate (FPRR):',
        `${reliabilityIdx.fprr.percent.toFixed(1)}% (${reliabilityIdx.fprr.bandLabel}; normal ${fprrRange.min}–${fprrRange.max}%)`,
      ])
    }
    info.push([
      '',
      `Reliability-index reference ranges from ${RELIABILITY_REFERENCE_RANGES.citation}.`,
    ])
  }

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

  // Which map to render is determined by test type: Goldmann (kinetic)
  // produces isopters → draw the visual-field / isopter plot. Static
  // (threshold or suprathreshold grid) produces per-location sensitivity
  // → draw the dB heatmap. Legacy results with no testType are treated
  // as Goldmann via the shared helper.
  const showGoldmannMap = isGoldmannResult(result)

  const mapSizeMm = 85

  if (showGoldmannMap) {
    // Visual field map — rendered as image matching on-screen appearance
    y = drawSection(doc, isBinocular ? 'Combined Visual Field Map (OU)' : 'Visual Field Map', y, margin)
    y += 2

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
  } else {
    // Sensitivity heatmap — measured dB from threshold static tests. Uses
    // the same IDW + jet_r rendering as the on-screen SensitivityMap. If
    // the result has no measured thresholds the section is skipped.
    const sensImg = await renderSensitivityImage(result, 800)
    if (sensImg) {
      const sensNeeded = mapSizeMm + 20
      if (y + sensNeeded > pageH - 15) {
        doc.addPage()
        y = margin
      }

      y = drawSection(doc, 'Sensitivity Map', y, margin)
      y += 2

      const sensX = (pageW - mapSizeMm) / 2
      doc.addImage(sensImg, 'PNG', sensX, y, mapSizeMm, mapSizeMm)
      y += mapSizeMm + 4

      doc.setFontSize(7)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(100, 100, 100)
      doc.text('-5 dB (insensitive, red)  <->  40 dB (sensitive, blue)', pageW / 2, y, { align: 'center' })
      y += 6

      if (result.gridCoverage && result.gridCoverage.presentedLocations < result.gridCoverage.totalLocations) {
        doc.setFontSize(7)
        doc.setTextColor(180, 120, 40)
        doc.text(
          `Partial grid coverage: ${result.gridCoverage.presentedLocations} of ${result.gridCoverage.totalLocations} locations presented (outer points fell outside the calibrated display).`,
          pageW / 2,
          y,
          { align: 'center', maxWidth: pageW - margin * 2 },
        )
        y += 6
      }
    }
  }

  // Per-eye radar maps for binocular Goldmann tests. Static binocular
  // PDFs omit per-eye isopter radars (they aren't meaningful for static
  // sessions — the sensitivity heatmap above already conveys per-location
  // loss).
  if (showGoldmannMap && isBinocular && (options?.rightEyePoints || options?.leftEyePoints)) {
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
  const expectedArea = expectedNormalArea(maxEccDeg, result.calibration)
  if (iii4eArea != null) {
    const classification = classifyField(iii4eArea, maxEccDeg, result.calibration)
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
  doc.text(`Methodology and definitions: ${APP_DOMAIN}/methods`, margin, pageH - 14)
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
    const classification = classifyField(iii4eArea, maxEccDeg, result.calibration)
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

  // ── Pattern modifiers (ring scotoma, asymmetry) ──
  // Additive overlays on the headline severity tier. In the in-app
  // panel these render as coloured chips next to the classification;
  // here we print them as small cards right after the classification so
  // a user with, e.g., moderate constriction + ring scotoma sees both.
  const patterns = detectFieldPatterns(result.points, result.isopterAreas)
  for (const p of patterns) {
    if (y > pageH - 30) {
      doc.addPage()
      y = margin
    }
    y = drawSection(doc, p.label, y, margin)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...TONE_RGB[p.tone])
    doc.text(p.label, margin + 2, y)
    y += 4
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(60, 60, 60)
    y = drawWrappedText(doc, p.description, margin + 2, y, contentW - 4, 8)
    y += 3
  }

  // ── Sensitivity gradient ──
  const gradient = analyzeSensitivityGradient(result.isopterAreas)
  if (gradient) {
    y = drawSection(doc, 'Sensitivity Gradient', y, margin)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...TONE_RGB[gradient.tone])
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
    doc.setTextColor(...TONE_RGB[centralIsland.tone])
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

  // ── RP-specific indicators ──
  // Filtered to `present` findings to match the in-app panel — a long
  // list of "not detected" cards is noise in a printed report.
  const rpFindings = detectRPFindings(
    result.points,
    result.isopterAreas,
    maxEccDeg,
    result.calibration,
  ).filter(f => f.present)
  if (rpFindings.length > 0) {
    if (y > pageH - 40) {
      doc.addPage()
      y = margin
    }
    y = drawSection(doc, 'RP Indicators', y, margin)
    for (const f of rpFindings) {
      if (y > pageH - 30) {
        doc.addPage()
        y = margin
      }
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(...TONE_RGB[f.tone])
      doc.text(f.label, margin + 2, y)
      y += 4
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(60, 60, 60)
      y = drawWrappedText(doc, f.description, margin + 2, y, contentW - 4, 8)
      y += 2
    }
    y += 2
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
      doc.setTextColor(...TONE_RGB[a.tone])
      y = drawWrappedText(doc, ANOMALY_GLYPH[a.icon] + a.label, margin + 2, y, contentW - 4, 8.5)

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
    'DISCLAIMER: This tool has not been validated against a clinical perimeter. ' +
    'This report is generated from a screen-based self-check and is intended for self-monitoring purposes only. ' +
    'Results may differ from clinical perimetry due to screen limitations, uncontrolled viewing distance, ' +
    'and the absence of standardized testing conditions. Always consult your ophthalmologist for diagnosis and treatment decisions. ' +
    'Use this tool to notice changes in your own field — not as a reliable clinical indicator. ' +
    `Generated by ${APP_DOMAIN} ${APP_NAME} self-check.`,
    contentW,
  )
  doc.text(disclaimer, margin, y)

  // Page 2 footer
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(160, 160, 160)
  doc.text(`Methodology and definitions: ${APP_DOMAIN}/methods`, margin, pageH - 14)
  doc.text(`Report generated: ${new Date().toLocaleString('en-GB')}  |  ${APP_DOMAIN}  |  Page 2 of 2`, margin, pageH - 10)

  // Save
  const filename = `visual-field-${eyeLabelForFilename(result.eye, isBinocular)}-${result.date.slice(0, 10)}.pdf`
  doc.save(filename)
}
