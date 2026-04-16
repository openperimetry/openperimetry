// OVFX (Open Visual Field eXchange) v0.3.0 import/export.
// Spec: https://github.com/openperimetry/ovfx-spec

import type { CalibrationData, StimulusKey, StoredEye, TestPoint, TestResult, TestType } from './types'
import { ISOPTER_ORDER, STIMULI } from './types'
import { formatEyeLabel } from './eyeLabels'
import { APP_NAME, APP_URL, APP_VERSION } from './branding'

export const OVFX_VERSION = '0.3.0'

// ── OVFX v0.3.0 type definitions (minimal — mirrors the schema) ─────────────

type OvfxEye = 'left' | 'right' | 'both'
type OvfxTestKind = 'kinetic' | 'static' | 'ring'
type OvfxSetupType = 'screen' | 'bowl' | 'vr' | 'other'

interface OvfxScreenSetup {
  viewingDistanceCm: number
  pixelsPerDegree: number
  screenWidthPx: number
  screenHeightPx: number
  fixationOffsetPx: number
  maxEccentricityDeg: number
  brightnessFloor?: number
}

interface OvfxCalibration {
  reactionTimeMs?: number
  setup: {
    type: OvfxSetupType
    screen?: OvfxScreenSetup
    bowl?: unknown
    vr?: unknown
    other?: unknown
  }
}

interface OvfxStimulus {
  key: string
  sizeDeg: number
  intensity: number
  color?: string
  label?: string
}

interface OvfxPoint {
  stimulusKey: string
  meridianDeg: number
  eccentricityDeg: number
  detected: boolean
  sensitivityDb?: number
  rawEccentricityDeg?: number
  responseTimeMs?: number
  sectorIdx?: number
  repeat?: boolean
}

interface OvfxReliability {
  falsePositiveRate?: number
  falseNegativeRate?: number
  fixationLossRate?: number
  fixationMethod?: string
}

interface OvfxIsopter {
  stimulusKey: string
  areaSqDeg: number
}

interface OvfxSoftware {
  name: string
  version: string
  url?: string
}

export interface OvfxDocument {
  ovfxVersion: string
  id: string
  createdAt: string
  test: {
    type: OvfxTestKind
    eye: OvfxEye
    extendedField?: boolean
    binocularGroup?: string
    pattern?: string
    strategy?: string
    durationSeconds?: number
    notes?: string
  }
  calibration: OvfxCalibration
  stimuli: OvfxStimulus[]
  points: OvfxPoint[]
  reliability?: OvfxReliability
  isopters?: OvfxIsopter[]
  software?: OvfxSoftware
}

// ── Conversion helpers ──────────────────────────────────────────────────────

const TEST_TYPE_TO_OVFX: Record<TestType, OvfxTestKind> = {
  goldmann: 'kinetic',
  ring: 'ring',
  static: 'static',
}

const OVFX_TO_TEST_TYPE: Record<OvfxTestKind, TestType> = {
  kinetic: 'goldmann',
  ring: 'ring',
  static: 'static',
}

const TEST_STRATEGY: Record<TestType, string> = {
  goldmann: 'kinetic',
  ring: 'ring-sector',
  static: 'threshold',
}

// APP_VERSION is sourced from branding.ts, which falls back to 'dev'.

function stimuliUsedIn(points: TestPoint[]): OvfxStimulus[] {
  const used = new Set<StimulusKey>()
  for (const p of points) used.add(p.stimulus)
  const out: OvfxStimulus[] = []
  for (const key of ISOPTER_ORDER) {
    if (!used.has(key)) continue
    const def = STIMULI[key]
    out.push({
      key: def.key,
      sizeDeg: def.sizeDeg,
      intensity: def.intensityFrac,
      color: def.color,
      label: def.label,
    })
  }
  return out
}

function toOvfxPoint(p: TestPoint): OvfxPoint {
  // Normalize meridian into [0, 360). iemdr internally stores meridians as-is
  // from the test components, which may include values like 360 or -5.
  let m = p.meridianDeg % 360
  if (m < 0) m += 360
  if (m >= 360) m -= 360
  const out: OvfxPoint = {
    stimulusKey: p.stimulus,
    meridianDeg: m,
    eccentricityDeg: p.eccentricityDeg,
    detected: p.detected,
  }
  if (p.rawEccentricityDeg != null && p.rawEccentricityDeg !== p.eccentricityDeg) {
    out.rawEccentricityDeg = p.rawEccentricityDeg
  }
  return out
}

function fromOvfxPoint(p: OvfxPoint): TestPoint {
  const key = p.stimulusKey as StimulusKey
  return {
    meridianDeg: p.meridianDeg,
    eccentricityDeg: p.eccentricityDeg,
    rawEccentricityDeg: p.rawEccentricityDeg ?? p.eccentricityDeg,
    detected: p.detected,
    stimulus: key,
  }
}

// ── Export ──────────────────────────────────────────────────────────────────

/** Convert a TestResult to a single OVFX v0.3.0 document. Binocular tests are
 *  emitted as one combined document with eye: "both" — iemdr does not retain
 *  per-point eye provenance for binocular sessions. */
export function exportToOvfx(result: TestResult): OvfxDocument {
  const testType = result.testType ?? 'goldmann'
  const ovfxKind = TEST_TYPE_TO_OVFX[testType]
  const cal = result.calibration

  const screenSetup: OvfxScreenSetup = {
    viewingDistanceCm: cal.viewingDistanceCm,
    pixelsPerDegree: cal.pixelsPerDegree,
    screenWidthPx: cal.screenWidthPx ?? (typeof window !== 'undefined' ? window.innerWidth : 1600),
    screenHeightPx: cal.screenHeightPx ?? (typeof window !== 'undefined' ? window.innerHeight : 900),
    fixationOffsetPx: cal.fixationOffsetPx,
    maxEccentricityDeg: cal.maxEccentricityDeg,
    brightnessFloor: cal.brightnessFloor,
  }

  const doc: OvfxDocument = {
    ovfxVersion: OVFX_VERSION,
    id: result.id,
    createdAt: result.date,
    test: {
      type: ovfxKind,
      eye: result.eye,
      strategy: TEST_STRATEGY[testType],
      ...(result.binocularGroup ? { binocularGroup: result.binocularGroup } : {}),
    },
    calibration: {
      reactionTimeMs: cal.reactionTimeMs,
      setup: { type: 'screen', screen: screenSetup },
    },
    stimuli: stimuliUsedIn(result.points),
    points: result.points.map(toOvfxPoint),
    software: {
      name: APP_NAME,
      version: APP_VERSION,
      url: APP_URL,
    },
  }

  // Precomputed isopter areas are informative — include them when we have
  // something non-empty to emit.
  const isopters: OvfxIsopter[] = []
  for (const key of ISOPTER_ORDER) {
    const area = result.isopterAreas[key]
    if (area != null) isopters.push({ stimulusKey: key, areaSqDeg: area })
  }
  if (isopters.length > 0) doc.isopters = isopters

  return doc
}

/** Trigger a browser download for a result, packaged as an OVFX document. */
export function downloadOvfx(result: TestResult): void {
  const doc = exportToOvfx(result)
  const json = JSON.stringify(doc, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const eyeLabel = formatEyeLabel(result.eye)
  const datePart = result.date.slice(0, 10)
  const kindLabel = (result.testType ?? 'goldmann').toLowerCase()
  a.download = `vf_${datePart}_${eyeLabel}_${kindLabel}.ovfx.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Import ──────────────────────────────────────────────────────────────────

/** Raised when an OVFX document cannot be imported into an iemdr TestResult. */
export class OvfxImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OvfxImportError'
  }
}

function parseMajorMinor(version: string): [number, number] {
  const m = version.match(/^(\d+)\.(\d+)\./)
  if (!m) throw new OvfxImportError(`Unrecognized ovfxVersion "${version}"`)
  return [Number(m[1]), Number(m[2])]
}

/** Convert a single OVFX document to an iemdr TestResult. Supports OVFX 0.1.x,
 *  0.2.x, and 0.3.x — the schema evolutions only affect the calibration block,
 *  so the iemdr-facing shape is identical across versions. */
export function importFromOvfx(doc: OvfxDocument): TestResult {
  if (!doc || typeof doc !== 'object' || !('ovfxVersion' in doc)) {
    throw new OvfxImportError('Not an OVFX document (missing ovfxVersion)')
  }
  const [major, minor] = parseMajorMinor(String(doc.ovfxVersion))
  if (major !== 0) {
    throw new OvfxImportError(`Unsupported OVFX major version ${major}.x`)
  }
  if (minor > 3) {
    throw new OvfxImportError(
      `OVFX ${doc.ovfxVersion} is newer than this app supports (0.3.x). Update the app or edit the file to a supported version.`,
    )
  }

  const setup = doc.calibration?.setup
  if (!setup || setup.type !== 'screen' || !setup.screen) {
    throw new OvfxImportError(
      `Only OVFX documents with a screen setup can be imported into ${APP_NAME}. ` +
        'Bowl or VR documents are valid OVFX but this app has no way to render them at 1:1.',
    )
  }

  const screen = setup.screen
  // Some v0.1.x producers put maxEccentricityDeg at the top of calibration
  // instead of inside setup.screen. Tolerate either location on import.
  const legacyMaxEcc = (doc.calibration as unknown as { maxEccentricityDeg?: number }).maxEccentricityDeg
  const maxEcc = screen.maxEccentricityDeg ?? legacyMaxEcc
  if (maxEcc == null) {
    throw new OvfxImportError('Document is missing maxEccentricityDeg (required for rendering)')
  }

  const calibration: CalibrationData = {
    pixelsPerDegree: screen.pixelsPerDegree,
    maxEccentricityDeg: maxEcc,
    viewingDistanceCm: screen.viewingDistanceCm,
    brightnessFloor: screen.brightnessFloor ?? 0.04,
    reactionTimeMs: doc.calibration.reactionTimeMs ?? 250,
    fixationOffsetPx: screen.fixationOffsetPx,
    screenWidthPx: screen.screenWidthPx,
    screenHeightPx: screen.screenHeightPx,
  }

  const testType: TestType = OVFX_TO_TEST_TYPE[doc.test.type]
  // iemdr stores single-eye results only — a 'both' document would need
  // splitting, which we can't do without per-point eye provenance. Reject.
  if (doc.test.eye === 'both') {
    throw new OvfxImportError(
      'OVFX documents with eye: "both" cannot be imported directly. Split the session into one document per eye with a shared test.binocularGroup and re-import both files.',
    )
  }
  const eye: StoredEye = doc.test.eye as StoredEye

  // Map points — drop any whose stimulusKey is unknown to iemdr instead of
  // failing the whole import.
  const validKeys = new Set<StimulusKey>(ISOPTER_ORDER)
  const points: TestPoint[] = doc.points
    .filter((p) => validKeys.has(p.stimulusKey as StimulusKey))
    .map(fromOvfxPoint)

  // Precomputed areas passthrough (optional in the spec).
  const isopterAreas: Partial<Record<StimulusKey, number>> = {}
  for (const iso of doc.isopters ?? []) {
    if (validKeys.has(iso.stimulusKey as StimulusKey)) {
      isopterAreas[iso.stimulusKey as StimulusKey] = iso.areaSqDeg
    }
  }

  return {
    id: crypto.randomUUID(),
    eye,
    date: doc.createdAt,
    points,
    isopterAreas,
    calibration,
    testType,
    ...(doc.test.binocularGroup ? { binocularGroup: doc.test.binocularGroup } : {}),
  }
}

/** Parse a user-supplied file into one or more TestResults. Supports one
 *  OVFX document per file. Rejects with OvfxImportError on failure. */
export async function parseOvfxFile(file: File): Promise<TestResult> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new OvfxImportError(`${file.name} is not valid JSON: ${(err as Error).message}`)
  }
  return importFromOvfx(parsed as OvfxDocument)
}
