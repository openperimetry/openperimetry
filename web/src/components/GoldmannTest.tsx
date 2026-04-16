import { useState, useEffect, useRef, useCallback } from 'react'
import type { CalibrationData, StoredEye, TestPoint, TestResult, StimulusKey } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { VisualFieldMap } from './VisualFieldMap'
import { calcIsopterAreas } from '../isopterCalc'
import { Interpretation } from './Interpretation'
import { VisionSimulator } from './VisionSimulator'
import { saveResult, saveSurvey, hasSurveyForResult, getDeviceId } from '../storage'
import { trackEvent } from '../api'
import { exportResultPDF } from '../pdfExport'
import { ScenarioOverlay } from './ScenarioOverlay'
import { PostTestSurvey } from './PostTestSurvey'
import type { SurveyResponse } from './PostTestSurvey'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'
import { GOLDMANN } from '../constants'

// ---------- constants ----------
const BASE_MERIDIANS = Array.from({ length: 12 }, (_, i) => i * 30)
const FINE_MERIDIANS = Array.from({ length: 24 }, (_, i) => i * 15) // every 15° for central

// Speed presets: normal vs fast
const SPEED_PRESETS = {
  normal: {
    stimulus: 3,
    medium: 2,
    slow: 1.5,
    preDelayMin: 1200,
    preDelayMax: 2800,
  },
  fast: {
    stimulus: 6,
    medium: 4,
    slow: 3,
    preDelayMin: 400,
    preDelayMax: 1000,
  },
} as const

const { MIN_RESPONSE_MS, BOUNDARY_OFFSET_DEG, ADAPTIVE_THRESHOLD_DEG, OUTLIER_FACTOR } = GOLDMANN

type Phase = 'instructions' | 'countdown' | 'interstitial' | 'wait' | 'moving' | 'paused' | 'results'

interface TestTask {
  meridianDeg: number
  stimulus: StimulusKey
  speed?: number          // override speed (deg/s), defaults to STIMULUS_SPEED_DEG_S
  startEccentricity?: number // override start position (deg), defaults to maxEccentricity
}

interface FixationOffset {
  x: number  // pixels from screen center (positive = right)
  y: number  // pixels from screen center (positive = down)
  maxEccDeg: number // max eccentricity testable with this offset
}

interface PhaseBlock {
  label: string
  description: string
  tasks: TestTask[]
  fixation?: FixationOffset // if set, fixation moves from center
}

export type SpeedMode = 'normal' | 'fast'

interface Props {
  eye: StoredEye
  calibration: CalibrationData
  extendedField: boolean
  onDone: () => void
  /** If set, called with raw results when test finishes — skips results screen */
  onComplete?: (points: TestPoint[]) => void
  /** Speed preset: 'normal' (default) or 'fast' (higher speed, shorter delays, fewer phases) */
  speedMode?: SpeedMode
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Build adaptive refinement tasks from initial III4e results */
function buildAdaptiveTasks(points: TestPoint[]): TestTask[] {
  const iii4e = points
    .filter(p => p.stimulus === 'III4e' && p.detected)
    .sort((a, b) => a.meridianDeg - b.meridianDeg)

  if (iii4e.length < 3) return []

  const tasks: TestTask[] = []
  const testedMeridians = new Set(points.map(p => p.meridianDeg))

  for (let i = 0; i < iii4e.length; i++) {
    const curr = iii4e[i]
    const next = iii4e[(i + 1) % iii4e.length]
    const eccDiff = Math.abs(curr.eccentricityDeg - next.eccentricityDeg)

    if (eccDiff > ADAPTIVE_THRESHOLD_DEG) {
      // Insert intermediate meridian
      let mid = (curr.meridianDeg + next.meridianDeg) / 2
      // Handle wrap-around (e.g., 330° and 0°)
      if (Math.abs(curr.meridianDeg - next.meridianDeg) > 180) {
        mid = ((curr.meridianDeg + next.meridianDeg + 360) / 2) % 360
      }
      mid = Math.round(mid / 5) * 5 // snap to 5° grid

      if (!testedMeridians.has(mid)) {
        tasks.push({ meridianDeg: mid, stimulus: 'III4e' })
        testedMeridians.add(mid)
      }
    }
  }

  return shuffle(tasks)
}

/** Build slow boundary tracing tasks from initial III4e results.
 *  For each meridian, start the stimulus just outside the detected edge
 *  and move inward at half speed for precise boundary mapping.
 *  Use finer meridian spacing (15°) around steep gradient areas.
 */
function buildBoundaryTasks(
  points: TestPoint[],
  maxEcc: number,
  slowSpeed = 1.5,
): TestTask[] {
  const iii4e = points
    .filter(p => p.stimulus === 'III4e' && p.detected)
    .sort((a, b) => a.meridianDeg - b.meridianDeg)

  if (iii4e.length < 3) return []

  const tasks: TestTask[] = []
  const testedMeridians = new Set<number>()

  // Re-test every detected meridian at slow speed near its boundary
  for (const p of iii4e) {
    const startEcc = Math.min(p.eccentricityDeg + BOUNDARY_OFFSET_DEG, maxEcc)
    tasks.push({
      meridianDeg: p.meridianDeg,
      stimulus: 'III4e',
      speed: slowSpeed,
      startEccentricity: startEcc,
    })
    testedMeridians.add(p.meridianDeg)
  }

  // Add finer meridians (15° between) where gradient is steep
  for (let i = 0; i < iii4e.length; i++) {
    const curr = iii4e[i]
    const next = iii4e[(i + 1) % iii4e.length]
    const eccDiff = Math.abs(curr.eccentricityDeg - next.eccentricityDeg)

    if (eccDiff > ADAPTIVE_THRESHOLD_DEG) {
      let mid = (curr.meridianDeg + next.meridianDeg) / 2
      if (Math.abs(curr.meridianDeg - next.meridianDeg) > 180) {
        mid = ((curr.meridianDeg + next.meridianDeg + 360) / 2) % 360
      }
      mid = Math.round(mid / 5) * 5

      if (!testedMeridians.has(mid)) {
        const avgEcc = (curr.eccentricityDeg + next.eccentricityDeg) / 2
        tasks.push({
          meridianDeg: mid,
          stimulus: 'III4e',
          speed: slowSpeed,
          startEccentricity: Math.min(avgEcc + BOUNDARY_OFFSET_DEG, maxEcc),
        })
        testedMeridians.add(mid)
      }
    }
  }

  return shuffle(tasks)
}

/** Detect outlier meridians: points that spike relative to both neighbors */
function findOutliers(points: TestPoint[], stimulus: StimulusKey): TestTask[] {
  const detected = points
    .filter(p => p.stimulus === stimulus && p.detected)
    .sort((a, b) => a.meridianDeg - b.meridianDeg)

  if (detected.length < 4) return []

  const tasks: TestTask[] = []
  for (let i = 0; i < detected.length; i++) {
    const prev = detected[(i - 1 + detected.length) % detected.length]
    const curr = detected[i]
    const next = detected[(i + 1) % detected.length]
    const neighborAvg = (prev.eccentricityDeg + next.eccentricityDeg) / 2
    const deviation = Math.abs(curr.eccentricityDeg - neighborAvg)
    const threshold = Math.max(4, neighborAvg * OUTLIER_FACTOR)

    if (deviation > threshold) {
      tasks.push({ meridianDeg: curr.meridianDeg, stimulus })
    }
  }
  return shuffle(tasks)
}

/**
 * Detect nesting violations: measurements of the current (dimmer) stimulus
 * that exceed the previously-recorded brighter-stimulus boundary at the
 * same meridian by more than `toleranceDeg`. Kinetic isopters are strictly
 * nested (I2e ⊆ I4e ⊆ III2e ⊆ III4e ⊆ V4e), so any crossing is a misclick,
 * false positive, or attention lapse and warrants a retest.
 */
function findNestingViolations(
  allPoints: TestPoint[],
  stimulus: StimulusKey,
  toleranceDeg: number,
): TestTask[] {
  const stimOrder = ISOPTER_ORDER.indexOf(stimulus)
  if (stimOrder <= 0) return []
  const brighter = new Set<StimulusKey>(ISOPTER_ORDER.slice(0, stimOrder))
  const currentDetected = allPoints
    .filter(p => p.stimulus === stimulus && p.detected)
  if (currentDetected.length < 3) return []
  // For each current-stimulus point, find the smallest brighter boundary
  // eccentricity within ±22.5° meridian. If the current point exceeds it
  // by more than `toleranceDeg`, flag for retest.
  const tasks: TestTask[] = []
  const meridianTol = 22.5
  for (const p of currentDetected) {
    let minBrighter = Infinity
    for (const q of allPoints) {
      if (!q.detected) continue
      if (!brighter.has(q.stimulus)) continue
      const d = Math.abs(((p.meridianDeg - q.meridianDeg) % 360 + 540) % 360 - 180)
      if (d > meridianTol) continue
      if (q.eccentricityDeg < minBrighter) minBrighter = q.eccentricityDeg
    }
    if (isFinite(minBrighter) && p.eccentricityDeg > minBrighter + toleranceDeg) {
      tasks.push({ meridianDeg: p.meridianDeg, stimulus })
    }
  }
  // Dedupe by meridian — we only need one retest per meridian even if
  // multiple brighter stimuli were crossed.
  const seen = new Set<number>()
  const deduped = tasks.filter(t => {
    if (seen.has(t.meridianDeg)) return false
    seen.add(t.meridianDeg)
    return true
  })
  return shuffle(deduped)
}

/** For meridians with multiple readings, keep the one closest to neighbor average */
// eslint-disable-next-line react-refresh/only-export-components
export function consolidatePoints(points: TestPoint[]): TestPoint[] {
  const result: TestPoint[] = []

  for (const stim of ISOPTER_ORDER) {
    const stimPoints = points.filter(p => p.stimulus === stim)
    // Group by meridian
    const byMeridian = new Map<number, TestPoint[]>()
    for (const p of stimPoints) {
      const arr = byMeridian.get(p.meridianDeg) ?? []
      arr.push(p)
      byMeridian.set(p.meridianDeg, arr)
    }

    // For single readings, keep as-is. For multiples, pick median eccentricity.
    for (const [, readings] of byMeridian) {
      if (readings.length === 1) {
        result.push(readings[0])
      } else {
        const detected = readings.filter(r => r.detected)
        if (detected.length === 0) {
          result.push(readings[0]) // all missed — keep one
        } else {
          // Use median eccentricity
          detected.sort((a, b) => a.eccentricityDeg - b.eccentricityDeg)
          result.push(detected[Math.floor(detected.length / 2)])
        }
      }
    }
  }
  return result
}

// Audio feedback removed — replaced by visual flash on fixation dot

/** Compute stimulus opacity accounting for brightness floor */
function stimulusOpacity(intensityFrac: number, brightnessFloor: number): number {
  // Floor is the minimum visible opacity. Scale intensityFrac above floor.
  // 4e (1.0) → full white. Lower fractions → scale toward floor.
  // Use log scale: 0.1 (2e) is 1 log unit below 1.0
  const minUsable = brightnessFloor * 1.5 // slightly above invisible
  return minUsable + (1.0 - minUsable) * intensityFrac
}

/** Build extended-field phase blocks. Only up/down passes are needed since
 *  the fixation is already offset horizontally (toward the nose) to maximize
 *  temporal field coverage on the screen. */
function buildExtendedBlocks(
  pxPerDeg: number,
  _screenW: number,
  screenH: number,
  fixationOffsetPx: number,
): PhaseBlock[] {
  const margin = 40 // px from edge
  const halfH = screenH / 2

  const configs: {
    label: string
    desc: string
    fx: number
    fy: number
    meridians: number[]
  }[] = [
    {
      label: 'Extended — upper field',
      desc: 'Fixation at bottom edge. Testing upper visual field.',
      fx: fixationOffsetPx, // keep same horizontal offset as main test
      fy: halfH - margin,
      meridians: [60, 75, 90, 105, 120],
    },
    {
      label: 'Extended — lower field',
      desc: 'Fixation at top edge. Testing lower visual field.',
      fx: fixationOffsetPx,
      fy: -(halfH - margin),
      meridians: [240, 255, 270, 285, 300],
    },
  ]

  return configs.map(cfg => {
    // Max eccentricity: distance from fixation to far edge
    const maxDown = halfH + cfg.fy - margin
    const maxUp = halfH - cfg.fy - margin
    const maxPx = Math.max(maxDown, maxUp)
    const maxEccDeg = Math.floor(maxPx / pxPerDeg)

    return {
      label: cfg.label,
      description: cfg.desc,
      fixation: { x: cfg.fx, y: cfg.fy, maxEccDeg },
      tasks: shuffle(cfg.meridians).map(m => ({
        meridianDeg: m,
        stimulus: 'III4e' as const,
      })),
    }
  })
}

/** Shortest angular distance between two meridians in [0, 180]. */
function meridianDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180)
  return d
}

/**
 * Compute an adaptive start eccentricity for an inner-isopter task, based on
 * previously-recorded points at brighter stimuli near the same meridian.
 *
 * Kinetic isopters are strictly nested: I2e ⊆ I4e ⊆ III2e ⊆ III4e ⊆ V4e. So
 * the current stimulus's boundary is guaranteed to be inside the previous
 * (brighter) stimulus's boundary at the same meridian, and we can start the
 * probe just outside that outer boundary without risk of the patient already
 * seeing the stimulus from the very first frame.
 *
 * This replaces the old hardcoded `innerStart=20°` / `centralStart=12°` caps
 * which truncated the recorded boundary for anyone whose real field extended
 * beyond those values (i.e., anyone without RP-level constriction). Those
 * caps produced isopters with roughly half the true area for I2e / III2e in
 * normally-sighted users.
 *
 * Fallback: if no prior points exist within the angular tolerance (e.g. the
 * very first inner-isopter task before any outer data, or a meridian no
 * outer block visited), return `edgeEcc` — a full screen-edge sweep.
 */
function adaptiveStartEccentricity(
  stimulus: StimulusKey,
  meridianDeg: number,
  priorPoints: TestPoint[],
  marginDeg: number,
  edgeEcc: number,
): number {
  const stimOrder = ISOPTER_ORDER.indexOf(stimulus)
  if (stimOrder <= 0) return edgeEcc // V4e or unknown — start at screen edge
  const brighter = new Set<StimulusKey>(ISOPTER_ORDER.slice(0, stimOrder))
  // 22.5° = slightly more than half the 30° BASE_MERIDIANS spacing so every
  // task meridian picks up at least one brighter-stimulus neighbor.
  const tolDeg = 22.5
  let maxEcc = -Infinity
  for (const p of priorPoints) {
    if (!p.detected) continue
    if (!brighter.has(p.stimulus)) continue
    if (meridianDistance(p.meridianDeg, meridianDeg) > tolDeg) continue
    if (p.eccentricityDeg > maxEcc) maxEcc = p.eccentricityDeg
  }
  if (!isFinite(maxEcc)) return edgeEcc
  return Math.min(edgeEcc, maxEcc + marginDeg)
}

/**
 * Compute the eccentricity (in degrees) at which a ray from fixation in the
 * given direction hits the screen edge.  This ensures stimuli always start
 * at — or just beyond — the visible screen boundary, like real kinetic perimetry.
 */
function edgeEccentricityDeg(
  meridianDeg: number,
  fixationOffsetX: number,
  fixationOffsetY: number,
  pixelsPerDegree: number,
): number {
  const rad = (meridianDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = -Math.sin(rad) // screen Y is inverted

  const halfW = window.innerWidth / 2
  const halfH = window.innerHeight / 2
  // fixation is at screen center + offset
  const fxFromCenter = fixationOffsetX
  const fyFromCenter = fixationOffsetY

  // Distance along the ray to each edge (only consider edges the ray points toward)
  let tMin = Infinity
  if (cos > 0.001) tMin = Math.min(tMin, (halfW - fxFromCenter) / cos)
  if (cos < -0.001) tMin = Math.min(tMin, (-halfW - fxFromCenter) / cos)
  if (sin > 0.001) tMin = Math.min(tMin, (halfH - fyFromCenter) / sin)
  if (sin < -0.001) tMin = Math.min(tMin, (-halfH - fyFromCenter) / sin)

  if (!isFinite(tMin) || tMin <= 0) tMin = halfW // fallback
  return tMin / pixelsPerDegree
}

export function GoldmannTest({ eye, calibration, extendedField, onDone, onComplete, speedMode = 'normal' }: Props) {
  const sp = SPEED_PRESETS[speedMode]
  const [phase, setPhase] = useState<Phase>('instructions')
  const [countdown, setCountdown] = useState(3)
  const [results, setResults] = useState<TestPoint[]>([])
  const [savedId, setSavedId] = useState<string | null>(null)
  const [surveyDone, setSurveyDone] = useState(false)
  const [showVisionSim, setShowVisionSim] = useState(false)

  // Phase blocks
  const [blocks, setBlocks] = useState<PhaseBlock[]>([])
  const [currentBlockIdx, setCurrentBlockIdx] = useState(0)
  const [, setTaskIdx] = useState(0)
  const [totalTasks, setTotalTasks] = useState(0)
  const [completedTasks, setCompletedTasks] = useState(0)

  // Current stimulus info
  const [, setCurrentStimLabel] = useState('')

  // Current fixation offset — defaults to the eye-specific horizontal offset
  const defaultFixation = { x: calibration.fixationOffsetPx, y: 0 }
  const [fixationXY, setFixationXY] = useState(defaultFixation)
  const [prevFixationXY, setPrevFixationXY] = useState<{ x: number; y: number } | null>(null)
  const fixationRef = useRef(defaultFixation)
  const blockMaxEccRef = useRef(0)

  // Refs for animation
  const fixationDotRef = useRef<HTMLDivElement>(null)
  const stimulusRef = useRef<HTMLDivElement>(null)
  const eccRef = useRef(0)
  const respondedRef = useRef(false)
  const rafRef = useRef(0)
  const lastTimeRef = useRef(0)
  const phaseRef = useRef<Phase>('instructions')
  const currentMeridianRef = useRef(0)
  const currentStimulusRef = useRef<StimulusKey>('III4e')
  const resultsRef = useRef<TestPoint[]>([])
  const blocksRef = useRef<PhaseBlock[]>([])
  const blockIdxRef = useRef(0)
  const taskIdxRef = useRef(0)
  const movingStartRef = useRef(0) // timestamp when stimulus started moving
  const currentSpeedRef = useRef<number>(sp.stimulus)
  const currentStartEccRef = useRef(0)
  // Deceleration zone for inner isopters: eccRef below rampStart ramps
  // linearly from the task's nominal (fast) speed down to slowSpeed at
  // eccentricity 0. 0 means "no ramp" — constant speed. Lets the dot cross
  // the uninteresting outer zone quickly, then slow down once it enters
  // the plausible boundary region the user actually needs time to react in.
  const currentRampStartRef = useRef(0)
  const currentSlowSpeedRef = useRef<number>(sp.slow)

  const { pixelsPerDegree, maxEccentricityDeg, brightnessFloor, reactionTimeMs } = calibration
  const isMobileTest = calibration.viewingDistanceCm <= 15
  const fixDotSize = isMobileTest ? 'w-[2px] h-[2px]' : 'w-3 h-3'
  const fixDotOffset = isMobileTest ? -1 : -6
  const fixDotRestPx = isMobileTest ? 2 : 8
  const fixDotRestOffset = -(fixDotRestPx / 2)

  // Initialize blockMaxEcc on first render
  if (blockMaxEccRef.current === 0) blockMaxEccRef.current = maxEccentricityDeg

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  // Tracking-event lifecycle (start fires on first stimulus, not button click)
  const startedTrackedRef = useRef(false)
  const completedTrackedRef = useRef(false)

  // ---------- build initial phase blocks ----------
  useEffect(() => {
    const phase1: PhaseBlock = {
      label: 'Initial scan',
      description: 'Mapping III4e isopter — 12 directions',
      tasks: shuffle(BASE_MERIDIANS).map(m => ({ meridianDeg: m, stimulus: 'III4e' as const })),
    }
    // Phases 3 & 4 are always planned; phase 2 (adaptive) gets inserted after phase 1
    const phase3: PhaseBlock = {
      label: 'Outer boundary',
      description: 'Mapping V4e — largest stimulus',
      tasks: shuffle(BASE_MERIDIANS).map(m => ({ meridianDeg: m, stimulus: 'V4e' as const })),
    }
    // Inner isopters (III2e, I4e, I2e) intentionally do NOT set
    // startEccentricity here. Instead, startCurrentTask() computes an
    // adaptive start per-meridian based on the previously-tested brighter
    // isopter's boundary at that meridian + BOUNDARY_OFFSET_DEG. That gives a
    // short, efficient sweep (like the old hardcoded 12°/20° caps) but
    // without truncating users whose real field extends beyond those values.

    const phase4: PhaseBlock = {
      label: 'Sensitivity',
      description: 'Mapping III2e — dimmer stimulus',
      tasks: shuffle(BASE_MERIDIANS).map(m => ({
        meridianDeg: m, stimulus: 'III2e' as const,
      })),
    }
    const phase5: PhaseBlock = {
      label: 'Central detail',
      description: 'Mapping I4e — small bright stimulus',
      tasks: shuffle(BASE_MERIDIANS).map(m => ({
        meridianDeg: m, stimulus: 'I4e' as const,
      })),
    }
    const phase6: PhaseBlock = {
      label: 'Central sensitivity',
      description: 'Mapping I2e — small dim stimulus',
      tasks: shuffle(FINE_MERIDIANS).map(m => ({
        meridianDeg: m, stimulus: 'I2e' as const, speed: sp.medium,
      })),
    }

    // Fast mode: keep all isopters but use 12 meridians for I2e instead of 24
    const phase6Fast: PhaseBlock = {
      label: 'Central sensitivity',
      description: 'Mapping I2e — small dim stimulus',
      tasks: shuffle(BASE_MERIDIANS).map(m => ({
        meridianDeg: m, stimulus: 'I2e' as const, speed: sp.medium,
      })),
    }
    // Normal: ~84 stimuli, ~15 min. Fast: ~60 stimuli + higher speed + shorter delay → ~5 min.
    let allBlocks = speedMode === 'fast'
      ? [phase1, phase3, phase4, phase5, phase6Fast]
      : [phase1, phase3, phase4, phase5, phase6]

    // Append extended-field passes if enabled
    if (extendedField) {
      const extBlocks = buildExtendedBlocks(
        pixelsPerDegree,
        window.innerWidth,
        window.innerHeight,
        calibration.fixationOffsetPx,
      )
      allBlocks = [...allBlocks, ...extBlocks]
    }

    setBlocks(allBlocks)
    blocksRef.current = allBlocks
    setTotalTasks(allBlocks.reduce((s, b) => s + b.tasks.length, 0))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- get current task ----------
  const getCurrentTask = useCallback((): TestTask | null => {
    const b = blocksRef.current[blockIdxRef.current]
    if (!b) return null
    return b.tasks[taskIdxRef.current] ?? null
  }, [])

  // ---------- advance to next task or next block ----------
  const advance = useCallback(() => {
    const block = blocksRef.current[blockIdxRef.current]
    if (!block) {
      exitFullscreen()
      setPhase('results')
      return
    }

    const nextTaskIdx = taskIdxRef.current + 1
    if (nextTaskIdx < block.tasks.length) {
      // Next task in current block
      taskIdxRef.current = nextTaskIdx
      setTaskIdx(nextTaskIdx)
      startCurrentTask()
    } else {
      // Block complete — post-block analysis
      const justFinished = blocksRef.current[blockIdxRef.current]
      const insertBlocks: PhaseBlock[] = []

      // After phase 1 (III4e scan): add adaptive refinement + boundary tracing
      if (blockIdxRef.current === 0) {
        const adaptiveTasks = buildAdaptiveTasks(resultsRef.current)
        if (adaptiveTasks.length > 0) {
          insertBlocks.push({
            label: 'Adaptive refinement',
            description: `Refining ${adaptiveTasks.length} problem areas at III4e`,
            tasks: adaptiveTasks,
          })
        }

        const boundaryTasks = buildBoundaryTasks(resultsRef.current, maxEccentricityDeg, sp.slow)
        if (boundaryTasks.length > 0) {
          insertBlocks.push({
            label: 'Boundary tracing',
            description: `Slow probing ${boundaryTasks.length} points near scotoma edges`,
            tasks: boundaryTasks,
          })
        }
      }

      // After any primary block: check for outliers AND cross-isopter
      // nesting violations, and re-test them. Skip for verification /
      // adaptive / boundary blocks to avoid infinite loops.
      const isRecheck = justFinished?.label.startsWith('Verification')
        || justFinished?.label.startsWith('Adaptive')
        || justFinished?.label.startsWith('Boundary')
        || justFinished?.label.startsWith('Extended')
      if (justFinished && justFinished.tasks.length > 0 && !isRecheck) {
        const stim = justFinished.tasks[0].stimulus
        const outlierTasks = findOutliers(resultsRef.current, stim)
        if (outlierTasks.length > 0) {
          insertBlocks.push({
            label: 'Verification',
            description: `Re-checking ${outlierTasks.length} outlier points at ${STIMULI[stim].label}`,
            tasks: outlierTasks,
          })
        }
        // Cross-isopter nesting check. Only runs for inner isopters
        // (anything dimmer than V4e) because only those have a brighter
        // reference to be clipped against. A 4° tolerance absorbs normal
        // measurement noise while catching real misclicks that push a
        // dim isopter well past the brighter envelope. Meridians already
        // queued by findOutliers are skipped to avoid duplicate retests.
        const stimOrder = ISOPTER_ORDER.indexOf(stim)
        if (stimOrder > 0) {
          const outlierMeridians = new Set(outlierTasks.map(t => t.meridianDeg))
          const nestingTasks = findNestingViolations(resultsRef.current, stim, 4)
            .filter(t => !outlierMeridians.has(t.meridianDeg))
          if (nestingTasks.length > 0) {
            insertBlocks.push({
              label: 'Verification',
              description: `Re-checking ${nestingTasks.length} ${STIMULI[stim].label} point(s) that crossed a brighter isopter`,
              tasks: nestingTasks,
            })
          }
        }
      }

      // Insert any new blocks right after the current one
      if (insertBlocks.length > 0) {
        const idx = blockIdxRef.current + 1
        blocksRef.current = [
          ...blocksRef.current.slice(0, idx),
          ...insertBlocks,
          ...blocksRef.current.slice(idx),
        ]
        setBlocks([...blocksRef.current])
        const extraTasks = insertBlocks.reduce((s, b) => s + b.tasks.length, 0)
        setTotalTasks(t => t + extraTasks)
      }

      // Move to next block
      const nextBlockIdx = blockIdxRef.current + 1
      if (nextBlockIdx >= blocksRef.current.length) {
        exitFullscreen()
      setPhase('results')
        return
      }

      blockIdxRef.current = nextBlockIdx
      taskIdxRef.current = 0
      setCurrentBlockIdx(nextBlockIdx)
      setTaskIdx(0)

      // Apply fixation offset for the new block — save previous position for arrow guide
      const oldFix = { ...fixationRef.current }
      const nextBlock = blocksRef.current[nextBlockIdx]
      const newFix = nextBlock?.fixation
        ? { x: nextBlock.fixation.x, y: nextBlock.fixation.y }
        : { x: calibration.fixationOffsetPx, y: 0 }

      // Only show arrow if fixation actually moved significantly (>20px)
      const dist = Math.sqrt((newFix.x - oldFix.x) ** 2 + (newFix.y - oldFix.y) ** 2)
      setPrevFixationXY(dist > 20 ? oldFix : null)

      fixationRef.current = newFix
      if (nextBlock?.fixation) {
        blockMaxEccRef.current = nextBlock.fixation.maxEccDeg
      } else {
        blockMaxEccRef.current = maxEccentricityDeg
      }
      setFixationXY(newFix)

      // Verification blocks skip the interstitial — just continue seamlessly
      const isVerification = nextBlock?.label.startsWith('Verification')
      if (isVerification) {
        startCurrentTask()
      } else {
        setPhase('interstitial')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- record result ----------
  const recordPoint = useCallback(
    (detected: boolean, ecc: number) => {
      cancelAnimationFrame(rafRef.current)
      if (stimulusRef.current) {
        stimulusRef.current.style.opacity = '0'
      }

      // Apply RT compensation: when user pressed, stimulus was actually
      // further out by speed × reactionTime (use current task's speed)
      const rawEcc = detected ? ecc : 0
      const rtComp = (currentSpeedRef.current * reactionTimeMs) / 1000
      // Cap at screen edge for this meridian so compensation can't exceed visible area
      const edgeCap = edgeEccentricityDeg(
        currentMeridianRef.current,
        fixationRef.current.x,
        fixationRef.current.y,
        pixelsPerDegree,
      )
      const compensatedEcc = detected
        ? Math.min(rawEcc + rtComp, edgeCap)
        : 0

      const point: TestPoint = {
        meridianDeg: currentMeridianRef.current,
        eccentricityDeg: compensatedEcc,
        rawEccentricityDeg: rawEcc,
        detected,
        stimulus: currentStimulusRef.current,
      }

      resultsRef.current = [...resultsRef.current, point]
      setResults(resultsRef.current)
      setCompletedTasks(c => c + 1)

      setTimeout(() => advance(), 300)
    },
    [advance],
  )

  // ---------- animation loop ----------
  const animate = useCallback(
    (now: number) => {
      if (phaseRef.current !== 'moving' || respondedRef.current) return

      const dt = lastTimeRef.current ? (now - lastTimeRef.current) / 1000 : 0
      lastTimeRef.current = now
      // Effective speed: nominal until eccentricity drops into the ramp
      // zone, then linearly decelerate toward slowSpeed. For inner isopters
      // (I2e, I4e, III2e) the nominal speed is set by the task and the
      // ramp kicks in just below the adaptive start, so the dot traverses
      // the known-invisible outer band fast and slows as it enters the
      // plausible boundary zone where the user needs reaction time.
      const fastSpeed = currentSpeedRef.current
      const slowSpeedVal = currentSlowSpeedRef.current
      const rampStart = currentRampStartRef.current
      let effectiveSpeed = fastSpeed
      if (rampStart > 0 && eccRef.current < rampStart) {
        const frac = Math.max(0, eccRef.current / rampStart)
        effectiveSpeed = slowSpeedVal + (fastSpeed - slowSpeedVal) * frac
      }
      eccRef.current -= effectiveSpeed * dt

      if (eccRef.current <= 0) {
        recordPoint(false, 0)
        return
      }

      if (stimulusRef.current) {
        const rad = (currentMeridianRef.current * Math.PI) / 180
        const r = eccRef.current * pixelsPerDegree
        // Offset from fixation point (which may not be screen center in extended mode)
        const fx = fixationRef.current.x
        const fy = fixationRef.current.y
        const x = fx + r * Math.cos(rad)
        const y = fy + -r * Math.sin(rad)
        const stim = STIMULI[currentStimulusRef.current]
        const sizePx = Math.max(4, Math.round(stim.sizeDeg * pixelsPerDegree))
        const half = sizePx / 2
        stimulusRef.current.style.width = `${sizePx}px`
        stimulusRef.current.style.height = `${sizePx}px`
        stimulusRef.current.style.transform = `translate(${-half + x}px, ${-half + y}px)`
        stimulusRef.current.style.opacity = String(
          stimulusOpacity(stim.intensityFrac, brightnessFloor),
        )
      }

      rafRef.current = requestAnimationFrame(animate)
    },
    [pixelsPerDegree, brightnessFloor, recordPoint],
  )

  // ---------- start current task ----------
  function startCurrentTask() {
    const task = getCurrentTask()
    if (!task) {
      advance()
      return
    }

    currentMeridianRef.current = task.meridianDeg
    currentStimulusRef.current = task.stimulus
    currentSpeedRef.current = task.speed ?? sp.stimulus

    // Compute the screen-edge distance for this meridian — used as the fallback
    // start and as the upper bound for the adaptive start.
    const edgeEcc = edgeEccentricityDeg(
      task.meridianDeg,
      fixationRef.current.x,
      fixationRef.current.y,
      pixelsPerDegree,
    )
    // Priority for start eccentricity:
    //   1. task.startEccentricity if explicitly set (adaptive refinement,
    //      boundary tracing, verification, or a requeue preserves it).
    //   2. Adaptive start just outside the previous brighter isopter's
    //      boundary at this meridian (efficient + correct for inner isopters).
    //   3. edgeEcc fallback (outermost block — V4e / III4e — has no prior
    //      data, so it sweeps from the screen edge).
    //
    // Extended-field blocks use a different fixation point than the main
    // session, so main-session points are in an incompatible coordinate frame
    // and must not drive the adaptive start — fall back to edgeEcc instead.
    const currentBlock = blocksRef.current[blockIdxRef.current]
    const isExtendedBlock = currentBlock?.fixation != null
    const adaptiveStart = isExtendedBlock
      ? edgeEcc
      : adaptiveStartEccentricity(
          task.stimulus,
          task.meridianDeg,
          resultsRef.current,
          BOUNDARY_OFFSET_DEG,
          edgeEcc,
        )
    currentStartEccRef.current = task.startEccentricity ?? adaptiveStart
    respondedRef.current = false
    eccRef.current = currentStartEccRef.current
    lastTimeRef.current = 0

    // Configure deceleration ramp. The stimulus races through the outer
    // 15% of the sweep at full speed, then linearly decelerates to slowSpeed
    // as it crosses into the plausible boundary zone. Applied to ALL
    // isopters: inner dim ones (I2e/I4e/III2e) where fast mode was too
    // quick to react to, AND the outer V4e/III4e where the RP preserved
    // central island may be buried deep inside the sweep. The user sees a
    // fast dot when detection is impossible and a slow dot when it's not.
    //
    // Extended-field blocks skip the ramp — they're a small additional
    // pass and the constant speed keeps timing predictable.
    if (!isExtendedBlock) {
      // Ramp starts at 85% of the sweep start. Fast outer 15%, decelerating
      // inner 85%. Slightly tighter floor of 4° so tasks that already start
      // close to centre still spend most of their distance decelerating.
      const rampStart = Math.max(4, currentStartEccRef.current * 0.85)
      currentRampStartRef.current = rampStart
      // Slow target: the preset slow speed, bounded below by half the fast
      // speed so we never crawl to the point of timing out normal-field
      // users.
      currentSlowSpeedRef.current = Math.max(sp.slow, currentSpeedRef.current * 0.5)
    } else {
      currentRampStartRef.current = 0
      currentSlowSpeedRef.current = currentSpeedRef.current
    }

    setCurrentStimLabel(STIMULI[task.stimulus].label)

    if (stimulusRef.current) {
      stimulusRef.current.style.opacity = '0'
    }

    setPhase('wait')

    const delay = sp.preDelayMin + Math.random() * (sp.preDelayMax - sp.preDelayMin)
    setTimeout(() => {
      if (respondedRef.current) return
      phaseRef.current = 'moving'
      movingStartRef.current = performance.now()
      setPhase('moving')
      if (!startedTrackedRef.current) {
        startedTrackedRef.current = true
        trackEvent('test_started', getDeviceId(), { testType: 'goldmann', eye, speedMode }).catch(() => {})
      }
      rafRef.current = requestAnimationFrame(animate)
    }, delay)
  }

  // ---------- re-queue current task (for false starts) ----------
  const requeueCurrent = useCallback(() => {
    // Add the current task back to end of the current block
    const block = blocksRef.current[blockIdxRef.current]
    if (block) {
      block.tasks.push({
        meridianDeg: currentMeridianRef.current,
        stimulus: currentStimulusRef.current,
        speed: currentSpeedRef.current,
        startEccentricity: currentStartEccRef.current,
      })
      setTotalTasks(t => t + 1)
    }
  }, [])

  // ---------- response handler ----------
  const handleResponse = useCallback(() => {
    if (phaseRef.current !== 'moving' || respondedRef.current) return
    respondedRef.current = true

    const elapsed = performance.now() - movingStartRef.current

    if (elapsed < MIN_RESPONSE_MS) {
      // False start — too fast to be real perception
      flashFixation('#ef4444', 300) // red flash = rejected
      cancelAnimationFrame(rafRef.current)
      if (stimulusRef.current) stimulusRef.current.style.opacity = '0'
      requeueCurrent()
      setTimeout(() => advance(), 500)
      return
    }

    flashFixation('#3b82f6', 150) // blue flash = confirmed
    recordPoint(true, eccRef.current)
  }, [recordPoint, requeueCurrent, advance])

  // ---------- pause / resume ----------
  const pauseResumeRef = useRef<Phase>('wait') // phase to resume to
  const pause = useCallback(() => {
    const cur = phaseRef.current
    if (cur === 'wait' || cur === 'moving' || cur === 'interstitial') {
      cancelAnimationFrame(rafRef.current)
      if (stimulusRef.current) stimulusRef.current.style.opacity = '0'
      pauseResumeRef.current = cur
      setPhase('paused')
    }
  }, [])

  const resume = useCallback(() => {
    const target = pauseResumeRef.current
    if (target === 'interstitial') {
      setPhase('interstitial')
    } else {
      // Restart current task from scratch
      startCurrentTask()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- keyboard listener ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault()
        if (phaseRef.current === 'paused') {
          resume()
        } else {
          pause()
        }
        return
      }
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault()
        if (phaseRef.current === 'paused') {
          resume()
        } else if (phaseRef.current === 'interstitial') {
          // Continue from interstitial → countdown → start
          startCountdown()
        } else {
          handleResponse()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleResponse, pause, resume])

  // ---------- show positioning screen for first block ----------
  const startPositioning = () => {
    enterFullscreen()
    blockIdxRef.current = 0
    taskIdxRef.current = 0
    setCurrentBlockIdx(0)
    setPhase('interstitial')
  }

  // ---------- wrap onDone to exit fullscreen ----------
  const handleDone = () => {
    exitFullscreen()
    onDone()
  }

  // ---------- fullscreen ----------
  // iPhone Safari does not support requestFullscreen() on arbitrary elements
  // (only iPadOS/Android/desktop do). For iPhone we fall back to a tiny
  // scrollTo nudge which convinces Safari to auto-hide its address bar in
  // landscape. Users who install as a PWA get the fullest experience thanks
  // to the apple-mobile-web-app-capable meta tag in index.html.
  const enterFullscreen = () => {
    try {
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>
      }
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {})
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen()
      }
    } catch { /* not supported */ }
    if (typeof window !== 'undefined') {
      window.scrollTo(0, 1)
    }
  }
  const exitFullscreen = () => {
    try {
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null
        webkitExitFullscreen?: () => Promise<void>
      }
      if (doc.fullscreenElement && doc.exitFullscreen) {
        doc.exitFullscreen().catch(() => {})
      } else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen()
      }
    } catch { /* not supported */ }
  }

  // ---------- countdown ----------
  const startCountdown = () => {
    enterFullscreen()
    setPhase('countdown')
    setCountdown(3)
  }

  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      startCurrentTask()
      return
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown])

  // ---------- cleanup ----------
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      if (startedTrackedRef.current && !completedTrackedRef.current) {
        const consolidated = consolidatePoints(resultsRef.current)
        trackEvent('test_aborted', getDeviceId(), {
          testType: 'goldmann', eye, phase: phaseRef.current,
          points: String(consolidated.length),
          detected: String(consolidated.filter(p => p.detected).length),
        }).catch(() => {})
      }
    }
  }, [eye])

  // Fire test_completed when results screen is reached
  useEffect(() => {
    if (phase === 'results' && startedTrackedRef.current && !completedTrackedRef.current) {
      completedTrackedRef.current = true
      const consolidated = consolidatePoints(results)
      trackEvent('test_completed', getDeviceId(), {
        testType: 'goldmann', eye,
        points: String(consolidated.length),
        detected: String(consolidated.filter(p => p.detected).length),
      }).catch(() => {})
    }
  }, [phase, eye, results])

  // ---------- save ----------
  const handleSave = () => {
    const consolidated = consolidatePoints(results)
    const result: TestResult = {
      id: crypto.randomUUID(),
      eye,
      date: new Date().toISOString(),
      points: consolidated,
      isopterAreas: calcIsopterAreas(consolidated),
      calibration,
      testType: 'goldmann',
    }
    saveResult(result)
    setSavedId(result.id)
  }

  // ---------- head positioning guide ----------
  // Side-view illustration: head in profile on the left facing a vertical
  // screen on the right, with an explicit distance callout. An earlier
  // top-down version with a horizontal "screen" line above the head
  // confused users into looking up, so this one is explicitly a side view.
  const HeadGuide = ({ compact = false }: { compact?: boolean }) => {
    const h = compact ? 140 : 180
    const w = 280
    const coveredEye = eye === 'right' ? 'left' : 'right'
    const screenX = w - 48
    const eyeY = 42

    return (
      <div className="flex flex-col items-center gap-2">
        <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="opacity-70">
          <defs>
            <marker id="arrowL" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 10 0 L 0 5 L 10 10 z" fill="#64748b" />
            </marker>
            <marker id="arrowR" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
            </marker>
          </defs>
          {/* Head profile (facing right) */}
          <circle cx={70} cy={45} r={24} fill="none" stroke="#64748b" strokeWidth={1.5} />
          {/* Nose */}
          <path d="M 92 45 L 99 50 L 92 55" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinejoin="round" />
          {/* Sight line from active (far-side) eye past the covered near-side
              eye to the screen. The near-side eye is hidden under the hand. */}
          <line
            x1={88} y1={eyeY}
            x2={screenX - 2} y2={eyeY}
            stroke="#fbbf24" strokeWidth={1} strokeDasharray="3,3" opacity={0.7}
          />
          {/* Neck */}
          <path d="M 60 67 Q 68 78 76 86" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          {/* Spine — leaning forward onto the desk */}
          <path d="M 76 86 Q 110 108 150 150" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          {/* Shoulder */}
          <path d="M 76 86 Q 80 94 84 102" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          {/* Upper arm — shoulder forward-down to elbow resting on desk */}
          <line x1={84} y1={102} x2={118} y2={150} stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          {/* Forearm — elbow angled back up to hand over the eye */}
          <line x1={118} y1={150} x2={84} y2={46} stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          {/* Hand — covering the near-side eye. Drawn as a small filled oval
              right over the eye position so it's clear which eye is covered. */}
          <ellipse cx={86} cy={42} rx={7} ry={5} fill="#475569" stroke="#94a3b8" strokeWidth={1.2} />
          {/* Desk surface */}
          <line x1={28} y1={154} x2={215} y2={154} stroke="#475569" strokeWidth={1.5} strokeLinecap="round" />
          {/* Desk edge hint */}
          <line x1={215} y1={154} x2={215} y2={168} stroke="#475569" strokeWidth={1} strokeLinecap="round" />
          {/* Screen — vertical bar */}
          <rect x={screenX} y={10} width={6} height={72} rx={1} fill="#334155" />
          <text x={screenX + 3} y={6} fill="#64748b" fontSize={9} textAnchor="middle">screen</text>
          {/* Fixation dot on screen */}
          <circle cx={screenX + 3} cy={eyeY} r={3} fill="#fbbf24" />
          {/* Distance callout */}
          <line
            x1={102} y1={eyeY + 22}
            x2={screenX} y2={eyeY + 22}
            stroke="#64748b" strokeWidth={1}
            markerStart="url(#arrowL)" markerEnd="url(#arrowR)"
          />
          <text
            x={(102 + screenX) / 2} y={eyeY + 18}
            fill="#94a3b8" fontSize={11} textAnchor="middle" fontWeight={600}
          >
            {calibration.viewingDistanceCm} cm
          </text>
        </svg>
        {!compact && (
          <p className="text-xs text-gray-500 text-center">
            Sit {calibration.viewingDistanceCm} cm from the screen.
            Cover your {coveredEye} eye and look straight at the yellow dot.
          </p>
        )}
      </div>
    )
  }

  // ---------- flash fixation dot for visual feedback ----------
  // Reads fixationRef.current rather than fixationXY state so it stays in
  // sync across block transitions. handleResponse captures flashFixation via
  // a stable useCallback closure; reading state here would freeze the dot at
  // the first-render fixation position — visible as the yellow dot snapping
  // back to the main-test offset after the first tap in an extended-field
  // block.
  const flashFixation = (color: string, durationMs: number) => {
    const dot = fixationDotRef.current
    if (!dot) return
    const flashSize = isMobileTest ? 3 : 12
    const restSize = isMobileTest ? 3 : 8
    const flashOff = -(flashSize / 2)
    const restOff = -(restSize / 2)
    const fx = fixationRef.current.x
    const fy = fixationRef.current.y
    dot.style.backgroundColor = color
    dot.style.width = `${flashSize}px`
    dot.style.height = `${flashSize}px`
    dot.style.marginLeft = `${flashOff + fx}px`
    dot.style.marginTop = `${flashOff + fy}px`
    setTimeout(() => {
      dot.style.backgroundColor = '#fbbf24'
      dot.style.width = `${restSize}px`
      dot.style.height = `${restSize}px`
      // Re-read the ref inside the timeout too — if the block advanced during
      // the flash, the rest position must match the NEW fixation, not the
      // one captured when the flash started.
      dot.style.marginLeft = `${restOff + fixationRef.current.x}px`
      dot.style.marginTop = `${restOff + fixationRef.current.y}px`
    }, durationMs)
  }

  // ---------- stimulus size for demo ----------
  const demoSizePx = Math.max(6, Math.round(0.43 * pixelsPerDegree))
  const demoHalf = demoSizePx / 2

  // ==================== RENDER ====================

  if (phase === 'instructions') {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-6">
        <div className="max-w-md space-y-6 text-center">
          <h1 className="text-2xl font-semibold">
            {eye === 'right' ? 'Right' : 'Left'} eye — multi-isopter
          </h1>

          {/* Head positioning guide */}
          <HeadGuide />

          {/* Visual demo */}
          <div className="relative w-full h-32 bg-gray-900 rounded-xl flex items-center justify-center overflow-hidden">
            <div className="w-2 h-2 rounded-full bg-yellow-400" />
            <div
              className="absolute rounded-full bg-white animate-[slideIn_3s_ease-in_infinite]"
              style={{ width: demoSizePx, height: demoSizePx, top: '50%', marginTop: -demoHalf }}
            />
            <span className="absolute bottom-2 text-xs text-gray-600">
              demo — the white dot moves toward the yellow center
            </span>
          </div>

          <div className="text-left space-y-3 text-gray-300">
            <p>Make sure you're sitting in a comfortable position before starting.</p>
            <p>1. Cover your <strong>{eye === 'right' ? 'left' : 'right'} eye</strong></p>
            <p>2. Stare at the <span className="text-yellow-400">yellow dot</span> — don't look away</p>
            <p>3. Dots of different <strong>sizes and brightness</strong> move toward center</p>
            <p>
              4. Press <kbd className="px-2 py-0.5 bg-gray-800 rounded text-sm">Space</kbd>,{' '}
              <strong>click the mouse</strong>, or <strong>tap</strong> the moment you see it in your peripheral vision
            </p>
          </div>

          <p className="text-xs text-gray-500">
            Self-monitoring tool, not a clinical diagnosis. Always consult your ophthalmologist.
          </p>
          <button
            onClick={startPositioning}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >
            Ready
          </button>
          <button onClick={handleDone} className="text-gray-500 hover:text-gray-300 text-sm">
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'countdown') {
    return (
      <div
        className="min-h-screen bg-gray-950 text-white select-none cursor-none relative overflow-hidden"
        onTouchStart={e => e.preventDefault()}
      >
        {/* Fixation dot at real position */}
        <div
          className={`absolute ${fixDotSize} rounded-full bg-yellow-400`}
          style={{
            top: '50%',
            left: '50%',
            marginLeft: fixDotOffset + fixationXY.x,
            marginTop: fixDotOffset + fixationXY.y,
          }}
        />
        {/* Countdown number above fixation */}
        <div
          className="absolute text-6xl font-light text-gray-500 animate-pulse"
          style={{
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -100%)',
            marginLeft: fixationXY.x,
            marginTop: -30 + fixationXY.y,
          }}
        >
          {countdown || 'Go'}
        </div>
      </div>
    )
  }

  if (phase === 'paused') {
    const progressPct = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center select-none p-6">
        <div className="text-center space-y-6 max-w-sm w-full">
          <h1 className="text-2xl font-semibold">Paused</h1>
          <p className="text-gray-400 text-sm">{completedTasks} of {totalTasks} points completed</p>

          {/* Progress bar */}
          <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <div className="space-y-3 pt-2">
            <button
              onClick={resume}
              className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
            >
              Resume
            </button>
            <button
              onClick={() => {
                // Save partial results and exit
                const consolidated = consolidatePoints(results)
                if (consolidated.length > 0) {
                  exitFullscreen()
      setPhase('results')
                } else {
                  handleDone()
                }
              }}
              className="w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
            >
              Stop test &amp; view results
            </button>
            <button
              onClick={handleDone}
              className="text-gray-500 hover:text-gray-300 text-sm"
            >
              Quit without saving
            </button>
          </div>

          <p className="text-xs text-gray-600">
            Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Esc</kbd> or <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Space</kbd> to resume
          </p>
        </div>
      </div>
    )
  }

  if (phase === 'interstitial') {
    const block = blocks[currentBlockIdx]
    // Fixation position for this block
    const fx = block?.fixation ? block.fixation.x : calibration.fixationOffsetPx
    const fy = block?.fixation ? block.fixation.y : 0
    return (
      <div
        className="min-h-screen bg-gray-950 text-white select-none cursor-pointer relative overflow-hidden"
        onPointerDown={() => startCountdown()}
      >
        {/* Arrow from previous fixation to new fixation */}
        {prevFixationXY && (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 5 }}
          >
            <defs>
              <marker
                id="arrowhead"
                markerWidth="10"
                markerHeight="8"
                refX="9"
                refY="4"
                orient="auto"
              >
                <path d="M 0 0 L 10 4 L 0 8 Z" fill="#fbbf24" />
              </marker>
            </defs>
            {/* Old fixation dot (dimmed) */}
            <circle
              cx={window.innerWidth / 2 + prevFixationXY.x}
              cy={window.innerHeight / 2 + prevFixationXY.y}
              r={5}
              fill="#fbbf24"
              opacity={0.25}
            />
            {/* "Look here" label at old position */}
            {(() => {
              const dx = fx - prevFixationXY.x
              const dy = fy - prevFixationXY.y
              const arrow = Math.abs(dy) > Math.abs(dx)
                ? (dy > 0 ? '↓' : '↑')
                : (dx > 0 ? '→' : '←')
              return (
                <text
                  x={window.innerWidth / 2 + prevFixationXY.x}
                  y={window.innerHeight / 2 + prevFixationXY.y + 20}
                  fill="#fbbf24"
                  fontSize={12}
                  textAnchor="middle"
                  opacity={0.6}
                >
                  move eyes {arrow}
                </text>
              )
            })()}
            {/* Arrow line from old to new */}
            <line
              x1={window.innerWidth / 2 + prevFixationXY.x}
              y1={window.innerHeight / 2 + prevFixationXY.y}
              x2={window.innerWidth / 2 + fx}
              y2={window.innerHeight / 2 + fy}
              stroke="#fbbf24"
              strokeWidth={2}
              strokeDasharray="6,4"
              opacity={0.4}
              markerEnd="url(#arrowhead)"
            />
          </svg>
        )}

        {/* Fixation dot at its real screen position */}
        <div
          className={`absolute ${fixDotSize} rounded-full bg-yellow-400`}
          style={{
            top: '50%',
            left: '50%',
            marginLeft: fixDotOffset + fx,
            marginTop: fixDotOffset + fy,
          }}
        />

        {/* Head silhouette — sized from calibration so proportions match real life */}
        {(() => {
          const ppd = pixelsPerDegree
          // Real human proportions at viewing distance as visual angles:
          // Head width ~15cm at 50cm ≈ 17°, head height ~23cm ≈ 26°
          // Eye width ~2.5cm ≈ 2.9°, inter-eye distance ~6.2cm ≈ 7.1°
          // Neck width ~10cm ≈ 11.4°, shoulder span ~40cm ≈ 38.7°
          const headW = 17 * ppd
          const headH = 26 * ppd
          const eyeW = 2.9 * ppd / 2  // rx
          const eyeH = 1.8 * ppd / 2  // ry
          const eyeSpacing = 7.1 * ppd / 2 // distance from center to each eye
          const neckW = 5.5 * ppd
          const neckH = 5 * ppd
          const shoulderSpan = 19 * ppd // half shoulder width
          const earW = 1.5 * ppd / 2
          const earH = 3.2 * ppd / 2
          const svgW = headW + 14 * ppd // extra for ears + shoulders
          const svgH = headH + 22 * ppd // head + neck + shoulders
          const cx = svgW / 2
          // Eyes at 40% from top of head
          const eyeY = headH * 0.46
          const headCY = headH * 0.5
          const noseY = headH * 0.62
          const mouthY = headH * 0.74
          const neckTop = headH
          const shoulderY = neckTop + neckH

          return (
            <svg
              className="absolute pointer-events-none"
              style={{
                top: '50%',
                left: '50%',
                marginLeft: -svgW / 2 + fx + (eye === 'right' ? -eyeSpacing : eyeSpacing),
                marginTop: -eyeY + fy,
                width: svgW,
                height: svgH,
                opacity: 0.12,
              }}
              viewBox={`0 0 ${svgW} ${svgH}`}
            >
              {/* Head */}
              <ellipse cx={cx} cy={headCY} rx={headW / 2} ry={headH / 2} fill="none" stroke="#94a3b8" strokeWidth={2} />
              {/* Ears */}
              <ellipse cx={cx - headW / 2 - earW * 0.4} cy={headCY} rx={earW} ry={earH} fill="none" stroke="#94a3b8" strokeWidth={1.5} />
              <ellipse cx={cx + headW / 2 + earW * 0.4} cy={headCY} rx={earW} ry={earH} fill="none" stroke="#94a3b8" strokeWidth={1.5} />
              {/* Eyes */}
              <ellipse cx={cx - eyeSpacing} cy={eyeY} rx={eyeW} ry={eyeH}
                fill={eye === 'left' ? '#fbbf24' : 'none'}
                stroke={eye === 'left' ? '#fbbf24' : '#64748b'}
                strokeWidth={1.5} opacity={eye === 'left' ? 0.5 : 0.3} />
              <ellipse cx={cx + eyeSpacing} cy={eyeY} rx={eyeW} ry={eyeH}
                fill={eye === 'right' ? '#fbbf24' : 'none'}
                stroke={eye === 'right' ? '#fbbf24' : '#64748b'}
                strokeWidth={1.5} opacity={eye === 'right' ? 0.5 : 0.3} />
              {/* X over covered eye */}
              {eye === 'right' ? (
                <>
                  <line x1={cx - eyeSpacing - eyeW} y1={eyeY - eyeH} x2={cx - eyeSpacing + eyeW} y2={eyeY + eyeH} stroke="#ef4444" strokeWidth={2.5} opacity={0.6} />
                  <line x1={cx - eyeSpacing - eyeW} y1={eyeY + eyeH} x2={cx - eyeSpacing + eyeW} y2={eyeY - eyeH} stroke="#ef4444" strokeWidth={2.5} opacity={0.6} />
                </>
              ) : (
                <>
                  <line x1={cx + eyeSpacing - eyeW} y1={eyeY - eyeH} x2={cx + eyeSpacing + eyeW} y2={eyeY + eyeH} stroke="#ef4444" strokeWidth={2.5} opacity={0.6} />
                  <line x1={cx + eyeSpacing - eyeW} y1={eyeY + eyeH} x2={cx + eyeSpacing + eyeW} y2={eyeY - eyeH} stroke="#ef4444" strokeWidth={2.5} opacity={0.6} />
                </>
              )}
              {/* Nose */}
              <path d={`M ${cx} ${eyeY + eyeH * 1.5} L ${cx - ppd * 0.8} ${noseY} Q ${cx} ${noseY + ppd * 0.5} ${cx + ppd * 0.8} ${noseY} Z`} fill="none" stroke="#94a3b8" strokeWidth={1.2} />
              {/* Mouth */}
              <path d={`M ${cx - ppd * 2} ${mouthY} Q ${cx} ${mouthY + ppd * 1.2} ${cx + ppd * 2} ${mouthY}`} fill="none" stroke="#94a3b8" strokeWidth={1.2} />
              {/* Neck */}
              <rect x={cx - neckW} y={neckTop} width={neckW * 2} height={neckH} rx={ppd} fill="none" stroke="#94a3b8" strokeWidth={2} />
              {/* Shoulders */}
              <path d={`M ${cx - neckW} ${shoulderY} Q ${cx - shoulderSpan * 0.7} ${shoulderY + ppd} ${cx - shoulderSpan} ${shoulderY + ppd * 5}`} fill="none" stroke="#94a3b8" strokeWidth={2} />
              <path d={`M ${cx + neckW} ${shoulderY} Q ${cx + shoulderSpan * 0.7} ${shoulderY + ppd} ${cx + shoulderSpan} ${shoulderY + ppd * 5}`} fill="none" stroke="#94a3b8" strokeWidth={2} />
            </svg>
          )
        })()}

        {/* Phase info near fixation point */}
        <div
          className="absolute text-center pointer-events-none"
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -100%)',
            marginLeft: fx,
            marginTop: -30 + fy,
            maxWidth: 280,
          }}
        >
          <p className="text-xs text-gray-500 mb-1">
            {currentBlockIdx + 1}/{blocks.length} — {completedTasks}/{totalTasks} pts
          </p>
          <h2 className="text-sm font-semibold text-white" aria-live="polite">{block?.label}</h2>
          <p className="text-gray-400 text-xs mt-1">{block?.description}</p>
          <p className="text-gray-500 text-xs mt-3">
            Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Space</kbd> or tap
          </p>
        </div>
      </div>
    )
  }

  if (phase === 'results') {
    const consolidated = consolidatePoints(results)

    // In binocular mode, hand results back to parent instead of showing results screen
    if (onComplete) {
      onComplete(consolidated)
      return null
    }

    // Separate standard-field points from extended-field points.
    // Extended tests use a shifted fixation and can produce eccentricities
    // far beyond maxEccentricityDeg — these shouldn't distort the main isopter.
    const standardPoints = consolidated.filter(p => p.eccentricityDeg <= maxEccentricityDeg + 2)
    const areas = calcIsopterAreas(standardPoints)
    // Auto-save on first render of results
    if (!savedId && consolidated.length > 0) {
      handleSave()
    }
    return (
      <div className="min-h-screen bg-gray-950 text-white p-6 overflow-y-auto">
        <main className="max-w-lg mx-auto space-y-6 pb-12">
          <h1 className="text-2xl font-semibold text-center">Results</h1>
          <p className="text-center text-xs text-gray-500">Goldmann kinetic perimetry · {eye === 'right' ? <abbr title="Oculus Dexter">OD</abbr> : <abbr title="Oculus Sinister">OS</abbr>}</p>
          {savedId && (
            <p className="text-center text-green-400 text-xs">
              Saved automatically — this result is now available on the Results page.
            </p>
          )}
          <VisualFieldMap
            points={standardPoints}
            eye={eye}
            maxEccentricity={maxEccentricityDeg}
            size={Math.min(600, window.innerWidth - 48)}
            calibration={calibration}
            enableVerify
          />
          {/* Area summary */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            {ISOPTER_ORDER.map(key => {
              const area = areas[key]
              if (area == null) return null
              return (
                <div key={key} className="bg-gray-900 rounded-lg px-3 py-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STIMULI[key].color }} />
                  <span className="text-gray-400">{STIMULI[key].label}</span>
                  <span className="ml-auto font-mono text-white">{area.toFixed(0)} deg²</span>
                </div>
              )
            })}
          </div>
          <ClinicalDisclaimer variant="results" />
          <Interpretation points={standardPoints} areas={areas} maxEccentricityDeg={maxEccentricityDeg} calibration={calibration} />
          <ScenarioOverlay userPoints={standardPoints} userAreas={areas} maxEccentricity={maxEccentricityDeg} />
          {/* Vision sim — collapsible, gets ALL points including extended */}
          {!showVisionSim ? (
            <button
              onClick={() => setShowVisionSim(true)}
              className="w-full py-3 bg-gray-900 hover:bg-gray-800 rounded-xl font-medium transition-colors border border-gray-800 hover:border-gray-700 text-sm"
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              Vision simulation
            </button>
          ) : (
            <div className="space-y-2">
              <button onClick={() => setShowVisionSim(false)} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                ▾ Hide vision simulation
              </button>
              <VisionSimulator points={consolidated} eye={eye} maxEccentricity={maxEccentricityDeg} />
            </div>
          )}
          {/* Survey — collapsed by default */}
          {savedId && !surveyDone && !hasSurveyForResult(savedId) && (
            <details className="group">
              <summary className="cursor-pointer text-center text-sm text-gray-400 hover:text-gray-300 transition-colors py-2 list-none">
                <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-gray-500 group-open:rotate-90 transition-transform" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                </svg>
                Quick feedback (optional)
              </summary>
              <div className="mt-3">
                <PostTestSurvey
                  onSubmit={(response: SurveyResponse) => {
                    saveSurvey(savedId, response)
                    setSurveyDone(true)
                  }}
                  onSkip={() => setSurveyDone(true)}
                />
              </div>
            </details>
          )}
          {surveyDone && (
            <p className="text-center text-green-400 text-xs">Thank you for your feedback!</p>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => {
                if (!savedId) return
                const result: TestResult = {
                  id: savedId,
                  eye,
                  date: new Date().toISOString(),
                  points: consolidated,
                  isopterAreas: areas,
                  calibration,
                  testType: 'goldmann',
                }
                exportResultPDF(result)
              }}
              className="flex-1 py-3 btn-primary rounded-xl font-medium text-white"
            >
              Export PDF
            </button>
            <button
              onClick={handleDone}
              className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg font-medium transition-colors"
            >
              Done
            </button>
          </div>
        </main>
      </div>
    )
  }

  // Active test (wait + moving phases)
  return (
    <div
      className="min-h-screen bg-gray-950 select-none cursor-none relative overflow-hidden"
      onPointerDown={handleResponse}
      role="application"
      aria-label="Visual field test in progress — press Space or tap when you see the stimulus"
    >
      <button
        type="button"
        onPointerDown={e => { e.stopPropagation(); pause() }}
        className="absolute bottom-4 right-4 z-20 min-w-[44px] min-h-[44px] px-3 rounded-full bg-white/[0.08] hover:bg-white/[0.15] text-gray-300 text-xs font-medium cursor-pointer flex items-center gap-1.5 backdrop-blur-sm border border-white/[0.1]"
        aria-label="Pause test"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden="true">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
        Pause
      </button>
      {/* Progress ring around fixation dot */}
      {totalTasks > 0 && !isMobileTest && (
        <svg
          className="absolute pointer-events-none"
          style={{
            top: '50%',
            left: '50%',
            marginLeft: -10 + fixationXY.x,
            marginTop: -10 + fixationXY.y,
            width: 20,
            height: 20,
          }}
          viewBox="0 0 20 20"
        >
          <circle cx={10} cy={10} r={8} fill="none" stroke="#1e293b" strokeWidth={1.5} />
          <circle
            cx={10} cy={10} r={8} fill="none" stroke="#3b82f6" strokeWidth={1.5}
            strokeDasharray={`${2 * Math.PI * 8}`}
            strokeDashoffset={`${2 * Math.PI * 8 * (1 - completedTasks / totalTasks)}`}
            transform="rotate(-90 10 10)"
            strokeLinecap="round"
            opacity={0.5}
          />
        </svg>
      )}
      {/* Fixation dot — offset in extended field mode */}
      <div
        ref={fixationDotRef}
        className="absolute rounded-full transition-colors duration-100"
        style={{
          top: '50%',
          left: '50%',
          width: fixDotRestPx,
          height: fixDotRestPx,
          backgroundColor: '#fbbf24',
          marginLeft: fixDotRestOffset + fixationXY.x,
          marginTop: fixDotRestOffset + fixationXY.y,
        }}
      />

      {/* Stimulus — positioned relative to fixation via transform */}
      <div
        ref={stimulusRef}
        className="absolute rounded-full bg-white"
        style={{ top: '50%', left: '50%', width: 6, height: 6, opacity: 0, willChange: 'transform' }}
      />

      {/* Removed bottom HUD — it was distracting near the fixation point */}
    </div>
  )
}
