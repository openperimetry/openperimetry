import { useState, useEffect, useRef, useCallback } from 'react'
import type { CalibrationData, StoredEye, TestPoint, TestResult, StimulusKey } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { VisualFieldMap } from './VisualFieldMap'
import { SensitivityMap } from './SensitivityMap'
import { deriveDbFromSuprathreshold, dbToOpacity } from '../sensitivity'
import { initStaircase, stepStaircase, type StaircaseState } from '../staircase'
import { calcIsopterAreas } from '../isopterCalc'
import { Interpretation } from './Interpretation'
import { VisionSimulator } from './VisionSimulator'
import { saveResult, saveSurvey, hasSurveyForResult, getDeviceId } from '../storage'
import { trackEvent } from '../api'
import { exportTrackedResultPDF } from '../pdfExportTracking'
import { ScenarioOverlay } from './ScenarioOverlay'
import { PostTestSurvey } from './PostTestSurvey'
import type { SurveyResponse } from './PostTestSurvey'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'
import { STATIC_TEST } from '../constants'
import { formatEyeLabel } from '../eyeLabels'
import { HeadGuide } from './HeadGuide'
import { degToPx } from '../geometry'
import { blindspotLocation } from '../blindspot'
import { stimulusDisplayColor } from '../stimulusDisplay'
import {
  SPEED_PRESETS,
  type SpeedPresetName,
} from '../testDefaults'
import { useAdvancedSettings } from '../advancedSettings'

// ---------- constants ----------
const DEFAULT_HEXAGONS = 100      // default number of test points per level
const DENSITY_EXPONENT = 1.5      // >1 = denser near center (Goldmann bowl → flat projection)
const { MIN_RESPONSE_MS, MIN_ECCENTRICITY_DEG, MAX_TESTABLE_ECCENTRICITY_DEG, BURST_STAGGER_MS } = STATIC_TEST

type SpeedSetting = SpeedPresetName

// Max eccentricity fraction per stimulus level.
// Dim stimuli are mildly capped below full field — the tail-end periphery
// is rarely sensitive enough for I2e even in normal eyes — but the cap is
// now gentle enough to cover the healthy detection range (I2e typically
// reaches ~22–28° in normally-sighted users, well inside 0.85 × maxEcc for
// a 30°+ field). Earlier values (0.65/0.75/0.85) were tuned for RP-style
// severe constriction and cut ~50% of the I2e area on healthy users.
// The unseen-zone exclusion still skips known-dead areas regardless.
const LEVEL_MAX_ECCENTRICITY_FRAC: Record<string, number> = {
  'V4e': 1.0,     // full field
  'III4e': 1.0,
  'III2e': 0.95,
  'I4e': 0.90,
  'I2e': 0.85,
}

type Phase = 'instructions' | 'countdown' | 'testing' | 'retest' | 'level-done' | 'paused' | 'results'

type PointStatus = 'seen' | 'unseen'

interface GridPoint {
  xDeg: number
  yDeg: number
  key: string
}

interface TestedPoint extends GridPoint {
  status: PointStatus
  stimulus: StimulusKey
  responseTimeMs?: number
}

interface Props {
  eye: StoredEye
  calibration: CalibrationData
  extendedField: boolean
  onDone: () => void
  onComplete?: (points: TestPoint[]) => void
}

// ---------- utility functions ----------

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function pointKey(xDeg: number, yDeg: number): string {
  return `${round2(xDeg)},${round2(yDeg)}`
}

/**
 * Generate density-weighted hex grid.
 * Uses a power-law radial transform: uniform hex grid in "compressed" space
 * is expanded outward, producing dense coverage near fixation and sparser
 * at the periphery — like projecting the Goldmann bowl onto a flat surface.
 */
function generateHexGrid(maxRadiusDeg: number, spacingDeg: number, exponent: number = 1): GridPoint[] {
  const points: GridPoint[] = []
  const seen = new Set<string>()
  const rowHeight = spacingDeg * Math.sqrt(3) / 2
  const maxRows = Math.ceil(maxRadiusDeg / rowHeight)
  const maxCols = Math.ceil(maxRadiusDeg / spacingDeg)

  for (let row = -maxRows; row <= maxRows; row++) {
    const uy = row * rowHeight
    const offset = (Math.abs(row) % 2 !== 0) ? spacingDeg / 2 : 0
    for (let col = -maxCols; col <= maxCols; col++) {
      const ux = col * spacingDeg + offset
      const uDist = Math.sqrt(ux * ux + uy * uy)
      if (uDist > maxRadiusDeg) continue

      let x: number, y: number
      if (exponent === 1 || uDist < 0.01) {
        // Uniform grid (or origin)
        x = round2(ux)
        y = round2(uy)
      } else {
        // Power-law: expand radial distance
        const vDist = maxRadiusDeg * Math.pow(uDist / maxRadiusDeg, exponent)
        const angle = Math.atan2(uy, ux)
        x = round2(vDist * Math.cos(angle))
        y = round2(vDist * Math.sin(angle))
      }

      const dist = Math.sqrt(x * x + y * y)
      if (dist < MIN_ECCENTRICITY_DEG) continue

      const key = pointKey(x, y)
      if (seen.has(key)) continue // skip duplicates from rounding
      seen.add(key)
      points.push({ xDeg: x, yDeg: y, key })
    }
  }
  return points
}

/**
 * Find nearby tested points within a search radius.
 * Works with any point distribution (uniform or density-weighted).
 */
function findNearbyTested(
  point: { xDeg: number; yDeg: number },
  tested: Map<string, TestedPoint>,
  maxDist: number,
  stimulusKey?: StimulusKey,
): TestedPoint[] {
  const nearby: TestedPoint[] = []
  const maxDist2 = maxDist * maxDist
  for (const [, tp] of tested) {
    if (stimulusKey && tp.stimulus !== stimulusKey) continue
    const dx = tp.xDeg - point.xDeg
    const dy = tp.yDeg - point.yDeg
    const d2 = dx * dx + dy * dy
    if (d2 > 0.01 && d2 <= maxDist2) {
      nearby.push(tp)
    }
  }
  return nearby
}

/** Check if a point is within screen bounds */
function isOnScreen(xDeg: number, yDeg: number, pxPerDeg: number, fixX: number): boolean {
  const px = window.innerWidth / 2 + fixX + xDeg * pxPerDeg
  const py = window.innerHeight / 2 - yDeg * pxPerDeg
  const margin = 20
  return px >= margin && px <= window.innerWidth - margin && py >= margin && py <= window.innerHeight - margin
}

/** Convert scatter points to TestPoint[] for results */
function scatterToTestPoints(points: Map<string, TestedPoint>): TestPoint[] {
  const result: TestPoint[] = []
  for (const [, tp] of points) {
    const ecc = Math.sqrt(tp.xDeg * tp.xDeg + tp.yDeg * tp.yDeg)
    const meridian = ((Math.atan2(tp.yDeg, tp.xDeg) * 180 / Math.PI) + 360) % 360
    result.push({
      meridianDeg: meridian,
      eccentricityDeg: ecc,
      rawEccentricityDeg: ecc,
      detected: tp.status === 'seen',
      stimulus: tp.stimulus,
    })
  }
  return result
}

export function StaticTest({ eye, calibration, extendedField, onDone, onComplete }: Props) {
  const { pixelsPerDegree, maxEccentricityDeg, fixationOffsetPx } = calibration
  const isMobileTest = calibration.viewingDistanceCm <= 15
  // Fixation dot sizing — explicit px so countdown and test phases match and so
  // the initial render doesn't start at the desktop size and then snap smaller
  // after the first flashFixation() call.
  const fixDotRestPx = isMobileTest ? 2 : 8
  const fixDotRestOffset = -(fixDotRestPx / 2)
  const fixDotSize = isMobileTest ? 'w-[2px] h-[2px]' : 'w-3 h-3'
  const fixDotOffset = isMobileTest ? -1 : -6

  // ---------- advanced settings ----------
  // User-adjustable overrides for catch-trial cadence, alert duration/text,
  // speed-preset timings, and background shade. Defaults to DEFAULT_ADVANCED_SETTINGS.
  const advanced = useAdvancedSettings()
  // Map background shade to the background class used on every phase shell.
  const bgClass =
    advanced.backgroundShade === 'light'
      ? 'bg-gray-400'
      : advanced.backgroundShade === 'medium'
        ? 'bg-gray-700'
        : 'bg-gray-950'

  // ---------- configurable settings (shown on instructions screen) ----------
  const [targetHexagons, setTargetHexagons] = useState(DEFAULT_HEXAGONS)
  const [speed, setSpeed] = useState<SpeedSetting>('normal')
  const [thresholdMode, setThresholdMode] = useState(false)
  // If the user enabled the advanced-settings speed-preset override, its
  // timings win over the selected built-in preset. Otherwise fall through
  // to SPEED_PRESETS[speed].
  const sp = advanced.speedPreset.override
    ? {
        stimulusMs: advanced.speedPreset.stimulusMs,
        responseMs: advanced.speedPreset.responseMs,
        gapMinMs: advanced.speedPreset.gapMinMs,
        gapMaxMs: advanced.speedPreset.gapMaxMs,
      }
    : SPEED_PRESETS[speed]

  // Fixation position
  const fixationXY = { x: fixationOffsetPx, y: 0 }

  // ---------- phase state ----------
  const [phase, setPhase] = useState<Phase>('instructions')
  const [countdown, setCountdown] = useState(3)
  const phaseRef = useRef<Phase>('instructions')

  // ---------- test state ----------
  const testedPointsRef = useRef<Map<string, TestedPoint>>(new Map())
  const [visiblePoints, setVisiblePoints] = useState<TestedPoint[]>([])
  const [totalPoints, setTotalPoints] = useState(0)
  const [remainingCount, setRemainingCount] = useState(0)

  // Grid spacing (calculated to get ~TARGET_HEXAGONS points)
  const gridSpacingRef = useRef(5)

  // Stimulus queue
  const queueRef = useRef<GridPoint[]>([])
  const currentPointRef = useRef<GridPoint | null>(null)

  // Burst mode
  const batchPointsRef = useRef<GridPoint[]>([])
  const verifyQueueRef = useRef<GridPoint[]>([])

  // Catch-trial tracking
  const isCatchTrialRef = useRef(false)
  const catchTrialRef = useRef<Array<{ detected: boolean }>>([])
  const truePositivesRef = useRef(0)
  const [showFixationLossAlert, setShowFixationLossAlert] = useState(false)

  // ISI false-positive tracking
  const isiActiveRef = useRef(false)
  const fpIsiPressesRef = useRef(0)

  // Stimulus level progression
  const [currentStimulusIdx, setCurrentStimulusIdx] = useState(0)
  const currentStimulusRef = useRef<StimulusKey>(ISOPTER_ORDER[0])

  // Threshold mode (4-2 dB staircase per location)
  const staircasesRef = useRef<Map<string, StaircaseState>>(new Map())
  const thresholdModeRef = useRef(false)
  const currentStaircaseKeyRef = useRef<string | null>(null)
  const thresholdResultsRef = useRef<TestPoint[]>([])

  // Timing
  const stimulusShownRef = useRef(false)
  const stimulusStartRef = useRef(0)
  const respondedRef = useRef(false)
  const delayTimeoutRef = useRef<ReturnType<typeof setTimeout>>(0 as unknown as ReturnType<typeof setTimeout>)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout>>(0 as unknown as ReturnType<typeof setTimeout>)
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout>>(0 as unknown as ReturnType<typeof setTimeout>)

  // DOM refs
  const fixationDotRef = useRef<HTMLDivElement>(null)
  const stimulusRef = useRef<HTMLDivElement>(null)
  const stimulus2Ref = useRef<HTMLDivElement>(null)

  // Results
  const [results, setResults] = useState<TestPoint[]>([])
  const [savedId, setSavedId] = useState<string | null>(null)
  const [showVisionSim, setShowVisionSim] = useState(false)
  const [surveyDone, setSurveyDone] = useState(false)

  // Paused state tracking
  const pausedPhaseRef = useRef<Phase>('testing')

  // Tracking-event lifecycle (start fires on first stimulus, not button click)
  const startedTrackedRef = useRef(false)
  const completedTrackedRef = useRef(false)
  const testStartedAtRef = useRef<number | null>(null)
  const getTestDurationSeconds = useCallback(() => {
    const startedAt = testStartedAtRef.current
    return startedAt == null ? undefined : Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  }, [])

  // Update phaseRef when phase changes
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  // Mirror thresholdMode state into a ref so static callbacks (presentNext
  // family, handleResponse, finishTest) can read the live value without
  // becoming stale through closure capture.
  useEffect(() => {
    thresholdModeRef.current = thresholdMode
  }, [thresholdMode])

  // Helper to clear all timeouts
  const clearAllTimeouts = useCallback(() => {
    clearTimeout(delayTimeoutRef.current)
    clearTimeout(hideTimeoutRef.current)
    clearTimeout(responseTimeoutRef.current)
  }, [])

  // ---------- get max screen extent ----------
  // Clamped to a realistic visual-field ceiling. Without clamping, short viewing
  // distances (phone mode at a few cm) produce 200°+ extents and the hex grid
  // generator overshoots the target point count by 3–4×.
  const getMaxExtentDeg = useCallback(() => {
    const halfW = window.innerWidth / 2
    const halfH = window.innerHeight / 2
    const raw = Math.max(
      (halfW + Math.abs(fixationXY.x)) / pixelsPerDegree,
      halfH / pixelsPerDegree,
    )
    return extendedField ? raw : Math.min(MAX_TESTABLE_ECCENTRICITY_DEG, raw)
  }, [pixelsPerDegree, fixationXY.x, extendedField])

  // ---------- get full screen area in deg² ----------
  // Clamp each axis to 2× the testable eccentricity so we don't feed an inflated
  // area to the spacing estimator when the screen subtends more than the cap.
  const getScreenAreaDeg2 = useCallback(() => {
    const maxAxis = MAX_TESTABLE_ECCENTRICITY_DEG * 2
    const wDeg = (window.innerWidth - 40) / pixelsPerDegree
    const hDeg = (window.innerHeight - 40) / pixelsPerDegree
    const screenWidthDeg = extendedField ? wDeg : Math.min(maxAxis, wDeg)
    const screenHeightDeg = extendedField ? hDeg : Math.min(maxAxis, hDeg)
    return screenWidthDeg * screenHeightDeg
  }, [pixelsPerDegree, extendedField])

  // Store the spacing used for each stimulus level (for proper exclusion radii)
  const levelSpacingRef = useRef<Map<StimulusKey, number>>(new Map())

  // Store the current grid for overlay visualization
  const currentGridRef = useRef<GridPoint[]>([])
  const [showGrid, setShowGrid] = useState(false)

  // ---------- check if a point falls inside an unseen zone ----------
  const isInUnseenZone = useCallback((xDeg: number, yDeg: number, unseenPoints: TestedPoint[]): boolean => {
    for (const u of unseenPoints) {
      // Use the exclusion radius from the level that determined this point unseen
      const levelSpacing = levelSpacingRef.current.get(u.stimulus) ?? 5
      const pad = levelSpacing * 0.45
      const dx = xDeg - u.xDeg
      const dy = yDeg - u.yDeg
      if (dx * dx + dy * dy <= pad * pad) return true
    }
    return false
  }, [])

  // ---------- generate and filter grid at a given spacing ----------
  const generateFilteredGrid = useCallback((spacingDeg: number, maxExtentDeg: number, unseenZonePoints: TestedPoint[], maxEccDeg?: number): GridPoint[] => {
    const grid = generateHexGrid(maxExtentDeg, spacingDeg, DENSITY_EXPONENT)
    return grid.filter(p => {
      if (maxEccDeg && Math.sqrt(p.xDeg * p.xDeg + p.yDeg * p.yDeg) > maxEccDeg) return false
      if (!isOnScreen(p.xDeg, p.yDeg, pixelsPerDegree, fixationXY.x)) return false
      if (unseenZonePoints.length > 0 && isInUnseenZone(p.xDeg, p.yDeg, unseenZonePoints)) return false
      return true
    })
  }, [isInUnseenZone, pixelsPerDegree, fixationXY.x])

  // ---------- initialize grid for a stimulus level ----------
  const initGrid = useCallback((stimulusKey: StimulusKey) => {
    const maxExtentDeg = getMaxExtentDeg()
    const currentIdx = ISOPTER_ORDER.indexOf(stimulusKey)
    const tested = testedPointsRef.current

    // Dimmer/smaller stimuli aren't detectable in the far periphery — limit eccentricity
    const eccFrac = LEVEL_MAX_ECCENTRICITY_FRAC[stimulusKey] ?? 1.0
    const levelMaxEcc = maxExtentDeg * eccFrac

    // Collect all unseen points from brighter (or equal) stimulus levels — these zones are dead
    const unseenZonePoints: TestedPoint[] = []
    for (const [, tp] of tested) {
      if (tp.status === 'unseen') {
        const tpIdx = ISOPTER_ORDER.indexOf(tp.stimulus)
        if (tpIdx <= currentIdx) unseenZonePoints.push(tp)
      }
    }

    // Estimate seen fraction from previous levels for better initial spacing
    const totalTested = tested.size
    const totalUnseen = unseenZonePoints.length
    const seenFraction = totalTested > 0 ? Math.max(0.1, 1 - totalUnseen / Math.max(totalTested, 1)) : 1

    // Initial spacing estimate: account for seen fraction and reduced eccentricity
    const fullArea = getScreenAreaDeg2()
    const effectiveArea = fullArea * seenFraction * eccFrac * eccFrac
    const initSpacing = Math.sqrt(effectiveArea * 2 / (Math.sqrt(3) * targetHexagons))

    // Spacing bounds scale with the field so the loop can actually converge for
    // very large fields (phone mode) without getting pinned to a hard max.
    const minSpacing = 1
    const maxSpacing = Math.max(12, maxExtentDeg / 3)

    // Iteratively adjust spacing until filtered count ≈ targetHexagons
    let spacing = Math.max(minSpacing, Math.min(maxSpacing, initSpacing))
    let filtered = generateFilteredGrid(spacing, maxExtentDeg, unseenZonePoints, levelMaxEcc)
    const tolerance = Math.max(5, targetHexagons * 0.1) // within 10%

    for (let iter = 0; iter < 12; iter++) {
      const count = filtered.length
      if (count === 0) { spacing *= 0.7; filtered = generateFilteredGrid(spacing, maxExtentDeg, unseenZonePoints, levelMaxEcc); continue }
      if (Math.abs(count - targetHexagons) <= tolerance) break
      // Damped ratio adjustment to avoid oscillation
      const rawRatio = Math.sqrt(count / targetHexagons)
      const ratio = 1 + (rawRatio - 1) * 0.6
      spacing = Math.max(minSpacing, Math.min(maxSpacing, spacing * ratio))
      filtered = generateFilteredGrid(spacing, maxExtentDeg, unseenZonePoints, levelMaxEcc)
    }

    gridSpacingRef.current = round2(spacing)
    levelSpacingRef.current.set(stimulusKey, round2(spacing))
    currentGridRef.current = filtered

    // Clear old test entries for the points we're about to test at this level
    for (const p of filtered) {
      const existing = tested.get(p.key)
      if (existing && existing.stimulus !== stimulusKey) {
        tested.delete(p.key)
      }
    }
    setVisiblePoints(Array.from(tested.values()))

    const shuffled = shuffle(filtered)
    queueRef.current = shuffled
    verifyQueueRef.current = []
    setTotalPoints(shuffled.length)
    setRemainingCount(shuffled.length)
    currentStimulusRef.current = stimulusKey
  }, [getMaxExtentDeg, getScreenAreaDeg2, generateFilteredGrid, targetHexagons])

  // ---------- show/hide stimulus ----------
  // Core helper: show stimulus at (xDeg, yDeg) using an explicit stim key.
  const showStimulusAt = useCallback((xDeg: number, yDeg: number, stimKey: StimulusKey, overrideOpacity?: number) => {
    const el = stimulusRef.current
    if (!el) return
    const stim = STIMULI[stimKey]
    const sizePx = Math.max(4, Math.round(degToPx(stim.sizeDeg, calibration)))
    const screenX = fixationXY.x + degToPx(xDeg, calibration)
    const screenY = fixationXY.y - degToPx(yDeg, calibration)
    el.style.width = `${sizePx}px`
    el.style.height = `${sizePx}px`
    el.style.marginLeft = `${-sizePx / 2 + screenX}px`
    el.style.marginTop = `${-sizePx / 2 + screenY}px`
    el.style.backgroundColor = stimulusDisplayColor(stimKey)
    el.style.opacity = `${overrideOpacity ?? stim.intensityFrac}`
    stimulusShownRef.current = true
  }, [pixelsPerDegree, fixationXY.x, fixationXY.y])

  const showStimulus = useCallback((xDeg: number, yDeg: number) => {
    showStimulusAt(xDeg, yDeg, currentStimulusRef.current)
  }, [showStimulusAt])

  const showStimulus2 = useCallback((xDeg: number, yDeg: number) => {
    const el = stimulus2Ref.current
    if (!el) return
    const stim = STIMULI[currentStimulusRef.current]
    const sizePx = Math.max(4, Math.round(degToPx(stim.sizeDeg, calibration)))
    const screenX = fixationXY.x + degToPx(xDeg, calibration)
    const screenY = fixationXY.y - degToPx(yDeg, calibration)
    el.style.width = `${sizePx}px`
    el.style.height = `${sizePx}px`
    el.style.marginLeft = `${-sizePx / 2 + screenX}px`
    el.style.marginTop = `${-sizePx / 2 + screenY}px`
    el.style.backgroundColor = stimulusDisplayColor(currentStimulusRef.current)
    el.style.opacity = `${stim.intensityFrac}`
  }, [pixelsPerDegree, fixationXY.x, fixationXY.y])

  const hideStimulus = useCallback(() => {
    const el = stimulusRef.current
    if (el) el.style.opacity = '0'
    const el2 = stimulus2Ref.current
    if (el2) el2.style.opacity = '0'
    stimulusShownRef.current = false
  }, [])

  // ---------- flash fixation ----------
  const flashFixation = useCallback((color: string, durationMs: number) => {
    const dot = fixationDotRef.current
    if (!dot) return
    const flashSize = isMobileTest ? 4 : 12
    const restSize = fixDotRestPx
    const flashOff = -(flashSize / 2)
    const restOff = fixDotRestOffset
    dot.style.backgroundColor = color
    dot.style.width = `${flashSize}px`
    dot.style.height = `${flashSize}px`
    dot.style.marginLeft = `${flashOff + fixationXY.x}px`
    dot.style.marginTop = `${flashOff + fixationXY.y}px`
    setTimeout(() => {
      dot.style.backgroundColor = '#fbbf24'
      dot.style.width = `${restSize}px`
      dot.style.height = `${restSize}px`
      dot.style.marginLeft = `${restOff + fixationXY.x}px`
      dot.style.marginTop = `${restOff + fixationXY.y}px`
    }, durationMs)
  }, [fixationXY.x, fixationXY.y, isMobileTest, fixDotRestPx, fixDotRestOffset])

  // ---------- record threshold-mode result ----------
  const recordThresholdPoint = useCallback((point: GridPoint, thresholdDb: number) => {
    const ecc = Math.sqrt(point.xDeg * point.xDeg + point.yDeg * point.yDeg)
    const meridian = ((Math.atan2(point.yDeg, point.xDeg) * 180 / Math.PI) + 360) % 360
    thresholdResultsRef.current.push({
      meridianDeg: meridian,
      eccentricityDeg: ecc,
      rawEccentricityDeg: ecc,
      detected: true,
      stimulus: 'III4e',
      thresholdDb,
    })
  }, [])

  const countPendingStaircases = useCallback(() => {
    let pending = 0
    for (const s of staircasesRef.current.values()) if (!s.done) pending++
    return pending
  }, [])

  // ---------- record result ----------
  const recordResult = useCallback((point: GridPoint, seen: boolean, responseTimeMs?: number) => {
    const tp: TestedPoint = {
      ...point,
      status: seen ? 'seen' : 'unseen',
      stimulus: currentStimulusRef.current,
      responseTimeMs,
    }
    testedPointsRef.current.set(point.key, tp)
    setVisiblePoints(Array.from(testedPointsRef.current.values()))
    setRemainingCount(queueRef.current.filter(p => !testedPointsRef.current.has(p.key)).length + verifyQueueRef.current.length)
  }, [])

  // ---------- find isolated unseen dots (suspicious - 0 unseen neighbors) ----------
  const findIsolatedUnseen = useCallback(() => {
    const tested = testedPointsRef.current
    const searchRadius = gridSpacingRef.current * 2.5 // generous for density-weighted grids
    const isolated: GridPoint[] = []

    for (const [, point] of tested) {
      if (point.status !== 'unseen') continue
      if (point.stimulus !== currentStimulusRef.current) continue

      const nearby = findNearbyTested(point, tested, searchRadius, currentStimulusRef.current)
      const hasUnseenNeighbor = nearby.some(n => n.status === 'unseen')

      if (!hasUnseenNeighbor) {
        isolated.push(point)
      }
    }
    return isolated
  }, [])

  // ---------- fullscreen ----------
  // iPhone Safari does not support requestFullscreen() on arbitrary elements
  // (only iPadOS/Android/desktop do). For iPhone we fall back to a tiny
  // scrollTo nudge which convinces Safari to auto-hide its address bar in
  // landscape. Users who install as a PWA get the fullest experience thanks
  // to the apple-mobile-web-app-capable meta tag in index.html.
  const enterFullscreen = useCallback(() => {
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
    // Nudge iPhone Safari to hide the URL bar on each entry.
    if (typeof window !== 'undefined') {
      window.scrollTo(0, 1)
    }
  }, [])
  const exitFullscreen = useCallback(() => {
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
  }, [])

  // ---------- finish test ----------
  const finishTest = useCallback(() => {
    exitFullscreen()
    const testPoints = thresholdModeRef.current
      ? [...thresholdResultsRef.current]
      : scatterToTestPoints(testedPointsRef.current)
    setResults(testPoints)
    setPhase('results')
  }, [exitFullscreen])

  // ---------- go to cleanup or next level ----------
  const advanceToNextLevel = useCallback(() => {
    const nextIdx = ISOPTER_ORDER.indexOf(currentStimulusRef.current) + 1
    if (nextIdx < ISOPTER_ORDER.length) {
      setCurrentStimulusIdx(nextIdx)
      currentStimulusRef.current = ISOPTER_ORDER[nextIdx]
      setPhase('level-done')
      exitFullscreen()
    } else {
      finishTest()
    }
  }, [exitFullscreen, finishTest])

  const goToCleanupOrNextLevel = useCallback(() => {
    hideStimulus()
    clearAllTimeouts()
    advanceToNextLevel()
  }, [hideStimulus, clearAllTimeouts, advanceToNextLevel])

  // ---------- pick a distant point for burst pairing ----------
  const pickDistantPoint = useCallback((first: GridPoint, queue: GridPoint[]): GridPoint | null => {
    let bestIdx = -1
    let bestScore = 0
    for (let i = 0; i < Math.min(queue.length, 20); i++) {
      const p = queue[i]
      if (testedPointsRef.current.has(p.key)) continue
      const dx = p.xDeg - first.xDeg
      const dy = p.yDeg - first.yDeg
      const dist = Math.sqrt(dx * dx + dy * dy)
      const diffQuadrant = (Math.sign(p.xDeg) !== Math.sign(first.xDeg)) || (Math.sign(p.yDeg) !== Math.sign(first.yDeg))
      const score = dist + (diffQuadrant ? 20 : 0)
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }
    if (bestIdx >= 0 && bestScore > 8) {
      const [picked] = queue.splice(bestIdx, 1)
      return picked
    }
    return null
  }, [])

  // Counter to interleave verify points among regular presentations
  const presentCountRef = useRef(0)

  // Stable ref to presentNext so presentCatchTrial can call it without a
  // circular useCallback dependency.
  const presentNextRef = useRef<(() => void) | null>(null)

  // ---------- catch-trial presentation ----------
  const presentCatchTrial = useCallback(() => {
    // Present a bright V4e stimulus at the anatomical blindspot. A patient
    // fixating correctly will NOT see it; detection is a fixation-loss signal.
    const bs = blindspotLocation(eye)
    const bsRad = (bs.meridianDeg * Math.PI) / 180
    const bsXDeg = bs.eccentricityDeg * Math.cos(bsRad)
    const bsYDeg = bs.eccentricityDeg * Math.sin(bsRad)

    isCatchTrialRef.current = true
    respondedRef.current = false
    // Use a sentinel GridPoint so currentPointRef is non-null (handleResponse guard)
    const catchPoint: GridPoint = { xDeg: bsXDeg, yDeg: bsYDeg, key: '__catch__' }
    currentPointRef.current = catchPoint
    batchPointsRef.current = []

    const delay = sp.gapMinMs + Math.random() * (sp.gapMaxMs - sp.gapMinMs)
    delayTimeoutRef.current = setTimeout(() => {
      if (phaseRef.current !== 'testing' && phaseRef.current !== 'retest') return
      isiActiveRef.current = false
      showStimulusAt(bsXDeg, bsYDeg, 'V4e')
      stimulusStartRef.current = performance.now()
      hideTimeoutRef.current = setTimeout(() => hideStimulus(), sp.stimulusMs)
      responseTimeoutRef.current = setTimeout(() => {
        if (!respondedRef.current && currentPointRef.current === catchPoint) {
          hideStimulus()
          // Miss: patient correctly did not see the catch trial
          catchTrialRef.current.push({ detected: false })
          isCatchTrialRef.current = false
          currentPointRef.current = null
          isiActiveRef.current = true
          presentNextRef.current?.()
        }
      }, sp.responseMs)
    }, delay)
    isiActiveRef.current = true
  }, [eye, showStimulusAt, hideStimulus, sp.gapMinMs, sp.gapMaxMs, sp.stimulusMs, sp.responseMs])

  // ---------- present next stimulus ----------
  const presentNext = useCallback(() => {
    if (phaseRef.current !== 'testing' && phaseRef.current !== 'retest') return

    isiActiveRef.current = false
    presentCountRef.current++

    // Every Nth presentation, inject a blindspot catch trial
    if (presentCountRef.current % advanced.catchTrialEveryN === 0) {
      presentCatchTrial()
      return
    }

    // Every 3rd presentation, take from verify queue if available (single dot, no burst)
    if (verifyQueueRef.current.length > 0 && presentCountRef.current % 3 === 0) {
      let verifyPoint: GridPoint | undefined
      while (verifyQueueRef.current.length > 0) {
        const candidate = verifyQueueRef.current.shift()!
        if (!testedPointsRef.current.has(candidate.key)) {
          verifyPoint = candidate
          break
        }
      }
      if (verifyPoint) {
        batchPointsRef.current = []
        currentPointRef.current = verifyPoint
        respondedRef.current = false
        const theVerifyPoint = verifyPoint
        const delay = sp.gapMinMs + Math.random() * (sp.gapMaxMs - sp.gapMinMs)
        delayTimeoutRef.current = setTimeout(() => {
          if (phaseRef.current !== 'testing' && phaseRef.current !== 'retest') return
          isiActiveRef.current = false
          showStimulus(theVerifyPoint.xDeg, theVerifyPoint.yDeg)
          stimulusStartRef.current = performance.now()
          hideTimeoutRef.current = setTimeout(() => hideStimulus(), sp.stimulusMs)
          responseTimeoutRef.current = setTimeout(() => {
            if (!respondedRef.current && currentPointRef.current === theVerifyPoint) {
              hideStimulus()
              recordResult(theVerifyPoint, false)
              flashFixation('#ef4444', 200)
              isiActiveRef.current = true
              presentNext()
            }
          }, sp.responseMs)
        }, delay)
        isiActiveRef.current = true
        return
      }
    }

    const queue = queueRef.current

    // Skip already-tested points
    while (queue.length > 0 && testedPointsRef.current.has(queue[0].key)) {
      queue.shift()
    }

    if (queue.length === 0) {
      // Check if verify queue still has items
      if (verifyQueueRef.current.length > 0) {
        presentCountRef.current = 2 // force verify on next call
        presentNext()
        return
      }
      // Queue exhausted
      if (phaseRef.current === 'testing') {
        // Check for isolated unseen dots — retest them
        const isolated = findIsolatedUnseen()
        if (isolated.length > 0) {
          // Remove from tested and re-queue
          for (const p of isolated) {
            testedPointsRef.current.delete(p.key)
          }
          setVisiblePoints(Array.from(testedPointsRef.current.values()))
          queueRef.current = shuffle(isolated)
          setRemainingCount(isolated.length)
          setPhase('retest')
          phaseRef.current = 'retest'
          const delay = sp.gapMinMs + Math.random() * (sp.gapMaxMs - sp.gapMinMs)
          delayTimeoutRef.current = setTimeout(presentNext, delay)
          isiActiveRef.current = true
          return
        }
        goToCleanupOrNextLevel()
        return
      }
      // Retest phase done
      goToCleanupOrNextLevel()
      return
    }

    // Get next point
    const point = queue.shift()!
    currentPointRef.current = point
    respondedRef.current = false
    batchPointsRef.current = [point]

    // BURST MODE: during testing (not retest), pair with a distant second point
    let burstPoint: GridPoint | null = null
    if (phaseRef.current === 'testing' && queue.length >= 2) {
      burstPoint = pickDistantPoint(point, queue)
      if (burstPoint) {
        batchPointsRef.current = [point, burstPoint]
      }
    }

    const delay = sp.gapMinMs + Math.random() * (sp.gapMaxMs - sp.gapMinMs)
    const thePoint = point
    const theBurstPoint = burstPoint
    const theBatch = [...batchPointsRef.current]

    delayTimeoutRef.current = setTimeout(() => {
      if (phaseRef.current !== 'testing' && phaseRef.current !== 'retest') return

      isiActiveRef.current = false
      showStimulus(thePoint.xDeg, thePoint.yDeg)
      stimulusStartRef.current = performance.now()

      if (theBurstPoint) {
        // BURST: show second dot with stagger
        setTimeout(() => {
          showStimulus2(theBurstPoint.xDeg, theBurstPoint.yDeg)
        }, BURST_STAGGER_MS)

        hideTimeoutRef.current = setTimeout(() => {
          hideStimulus()
        }, sp.stimulusMs + BURST_STAGGER_MS)

        responseTimeoutRef.current = setTimeout(() => {
          if (!respondedRef.current && currentPointRef.current === thePoint) {
            hideStimulus()
            // Neither dot seen — mark both unseen
            for (const bp of theBatch) {
              recordResult(bp, false)
            }
            flashFixation('#ef4444', 200)
            isiActiveRef.current = true
            presentNext()
          }
        }, sp.responseMs + BURST_STAGGER_MS)
      } else {
        // Single dot
        hideTimeoutRef.current = setTimeout(() => hideStimulus(), sp.stimulusMs)
        responseTimeoutRef.current = setTimeout(() => {
          if (!respondedRef.current && currentPointRef.current === thePoint) {
            hideStimulus()
            recordResult(thePoint, false)
            flashFixation('#ef4444', 200)
            isiActiveRef.current = true
            presentNext()
          }
        }, sp.responseMs)
      }
    }, delay)
    isiActiveRef.current = true
  }, [showStimulus, showStimulus2, hideStimulus, recordResult, flashFixation, pickDistantPoint, findIsolatedUnseen, goToCleanupOrNextLevel, presentCatchTrial, sp.gapMaxMs, sp.gapMinMs, sp.responseMs, sp.stimulusMs, advanced.catchTrialEveryN])

  // Keep the stable ref up to date so presentCatchTrial can call presentNext
  // without a circular useCallback dependency.
  presentNextRef.current = presentNext

  // ---------- present next stimulus (threshold mode) ----------
  // Round-robin through the staircases, presenting the next pending location.
  // Catch trials and burst pairing are intentionally skipped — the staircase
  // already presents each point ~6 times and reliability monitoring for
  // threshold mode can be added later.
  const presentNextThreshold = useCallback(() => {
    if (phaseRef.current !== 'testing') return
    isiActiveRef.current = false

    const queue = queueRef.current
    let point: GridPoint | null = null
    while (queue.length > 0) {
      const candidate = queue.shift()!
      const state = staircasesRef.current.get(candidate.key)
      if (state && !state.done) {
        point = candidate
        // Re-queue at the end so we round-robin until every staircase finishes.
        queue.push(candidate)
        break
      }
    }
    if (!point) {
      // All staircases done — go straight to results (no isopter progression
      // in threshold mode).
      finishTest()
      return
    }

    // Already validated in the while loop above, but re-fetch so TS has the narrow.
    const state = staircasesRef.current.get(point.key)
    if (!state) return
    const opacity = dbToOpacity(state.currentDb)
    currentPointRef.current = point
    currentStaircaseKeyRef.current = point.key
    respondedRef.current = false
    batchPointsRef.current = []

    const delay = sp.gapMinMs + Math.random() * (sp.gapMaxMs - sp.gapMinMs)
    const thePoint = point
    delayTimeoutRef.current = setTimeout(() => {
      if (phaseRef.current !== 'testing') return
      isiActiveRef.current = false
      showStimulusAt(thePoint.xDeg, thePoint.yDeg, 'III4e', opacity)
      stimulusStartRef.current = performance.now()
      hideTimeoutRef.current = setTimeout(() => hideStimulus(), sp.stimulusMs)
      responseTimeoutRef.current = setTimeout(() => {
        if (!respondedRef.current && currentStaircaseKeyRef.current === thePoint.key) {
          hideStimulus()
          // Timeout = unseen
          const s = staircasesRef.current.get(thePoint.key)
          if (!s) return
          const next = stepStaircase(s, false)
          staircasesRef.current.set(thePoint.key, next)
          if (next.done && next.thresholdDb != null) {
            recordThresholdPoint(thePoint, next.thresholdDb)
          }
          setRemainingCount(countPendingStaircases())
          isiActiveRef.current = true
          presentNextThreshold()
        }
      }, sp.responseMs)
    }, delay)
    isiActiveRef.current = true
  }, [showStimulusAt, hideStimulus, finishTest, recordThresholdPoint, countPendingStaircases, sp.gapMaxMs, sp.gapMinMs, sp.responseMs, sp.stimulusMs])

  // Dispatcher: pick the right scheduler based on test mode.
  const dispatchNext = useCallback(() => {
    if (thresholdModeRef.current) presentNextThreshold()
    else presentNext()
  }, [presentNext, presentNextThreshold])

  // ---------- handle response ----------
  const handleResponse = useCallback(() => {
    if (phaseRef.current !== 'testing' && phaseRef.current !== 'retest') return
    if (respondedRef.current || !currentPointRef.current) return
    if (stimulusStartRef.current === 0) return

    // Threshold mode: simple seen/unseen → step the matching staircase.
    // No burst, no verify queue, no catch trials. Must run before the
    // burst-aware response window check below (which adds BURST_STAGGER_MS).
    if (thresholdModeRef.current) {
      const elapsedT = performance.now() - stimulusStartRef.current
      if (elapsedT > sp.responseMs) return
      respondedRef.current = true
      if (elapsedT < MIN_RESPONSE_MS) {
        // False-positive guard: ignore but don't penalize the staircase.
        flashFixation('#ef4444', 300)
        clearAllTimeouts()
        hideStimulus()
        fpIsiPressesRef.current += 1
        isiActiveRef.current = true
        setTimeout(() => presentNextThreshold(), 500)
        return
      }
      flashFixation('#3b82f6', 150)
      clearAllTimeouts()
      hideStimulus()
      const key = currentStaircaseKeyRef.current
      const state = key != null ? staircasesRef.current.get(key) : undefined
      if (key != null && state) {
        const next = stepStaircase(state, true)
        staircasesRef.current.set(key, next)
        if (next.done && next.thresholdDb != null) {
          const point = currentGridRef.current.find(p => p.key === key)
          if (point) recordThresholdPoint(point, next.thresholdDb)
        }
        setRemainingCount(countPendingStaircases())
      }
      truePositivesRef.current += 1
      isiActiveRef.current = true
      presentNextThreshold()
      return
    }

    const elapsed = performance.now() - stimulusStartRef.current
    if (elapsed > sp.responseMs + BURST_STAGGER_MS) return

    respondedRef.current = true

    if (elapsed < MIN_RESPONSE_MS) {
      flashFixation('#ef4444', 300)
      for (const bp of batchPointsRef.current) {
        queueRef.current.push(bp)
      }
      batchPointsRef.current = []
      clearAllTimeouts()
      hideStimulus()
      isiActiveRef.current = true
      setTimeout(() => presentNext(), 500)
      return
    }

    flashFixation('#3b82f6', 150)
    clearAllTimeouts()
    hideStimulus()

    // Catch-trial response: patient reported seeing blindspot stimulus (fixation loss)
    if (isCatchTrialRef.current) {
      catchTrialRef.current.push({ detected: true })
      // Fixation-loss alert — inform the patient they looked away. A
      // setting of 0 ms disables the overlay entirely (advanced setting).
      if (advanced.fixationAlertMs > 0) {
        setShowFixationLossAlert(true)
        window.setTimeout(() => setShowFixationLossAlert(false), advanced.fixationAlertMs)
      }
      isCatchTrialRef.current = false
      currentPointRef.current = null
      isiActiveRef.current = true
      presentNext()
      return
    }

    // Burst: don't know which was seen — verify each individually
    if (batchPointsRef.current.length > 1) {
      verifyQueueRef.current = [...batchPointsRef.current]
      batchPointsRef.current = []
      isiActiveRef.current = true
      presentNext()
      return
    }

    truePositivesRef.current += 1
    recordResult(currentPointRef.current, true, elapsed)
    isiActiveRef.current = true
    presentNext()
  }, [flashFixation, hideStimulus, recordResult, presentNext, presentNextThreshold, recordThresholdPoint, countPendingStaircases, clearAllTimeouts, sp.responseMs, advanced.fixationAlertMs])

  // ---------- pause/resume ----------
  const pauseTest = useCallback(() => {
    if (phaseRef.current === 'testing' || phaseRef.current === 'retest') {
      pausedPhaseRef.current = phaseRef.current
      clearAllTimeouts()
      hideStimulus()
      setPhase('paused')
    }
  }, [clearAllTimeouts, hideStimulus])

  const resume = useCallback(() => {
    const resumePhase = pausedPhaseRef.current
    setPhase(resumePhase)
    phaseRef.current = resumePhase
    enterFullscreen()
    setTimeout(() => dispatchNext(), 1000)
  }, [dispatchNext, enterFullscreen])

  // ---------- keyboard/touch handling ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (phaseRef.current === 'testing' || phaseRef.current === 'retest') {
          pauseTest()
        } else if (phaseRef.current === 'paused') {
          resume()
        }
        return
      }
      if (e.key === 'g' || e.key === 'G') {
        setShowGrid(prev => !prev)
        return
      }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (phaseRef.current === 'paused') {
          resume()
        } else {
          if (isiActiveRef.current) {
            fpIsiPressesRef.current += 1
            return
          }
          handleResponse()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleResponse, resume, pauseTest])

  const handlePointerDown = useCallback(() => {
    if (isiActiveRef.current) {
      fpIsiPressesRef.current += 1
      return
    }
    handleResponse()
  }, [handleResponse])

  // ---------- start test ----------
  const startTest = useCallback(() => {
    enterFullscreen()
    testedPointsRef.current.clear()
    setVisiblePoints([])
    // Reset catch-trial and reliability counters
    catchTrialRef.current = []
    truePositivesRef.current = 0
    isCatchTrialRef.current = false
    presentCountRef.current = 0
    isiActiveRef.current = false
    fpIsiPressesRef.current = 0
    staircasesRef.current.clear()
    thresholdResultsRef.current = []
    if (thresholdMode) {
      thresholdModeRef.current = true
      // One hex grid, Goldmann III, no isopter progression. Coarser spacing
      // than suprathreshold because each location takes ~3-6 presentations.
      const maxExtent = getMaxExtentDeg()
      const screenArea = getScreenAreaDeg2()
      const targetCount = Math.max(20, Math.round(targetHexagons / 3))
      const spacing = Math.sqrt(screenArea * 2 / (Math.sqrt(3) * targetCount))
      const grid = generateHexGrid(maxExtent, spacing, DENSITY_EXPONENT)
        .filter(p => isOnScreen(p.xDeg, p.yDeg, pixelsPerDegree, fixationXY.x))
      currentGridRef.current = grid
      // Prior seed: 25 dB — HFA-normal midpoint; staircase converges quickly.
      const PRIOR_DB = 25
      for (const p of grid) {
        staircasesRef.current.set(p.key, initStaircase(PRIOR_DB))
      }
      queueRef.current = shuffle(grid)
      verifyQueueRef.current = []
      setTotalPoints(grid.length)
      setRemainingCount(grid.length)
      setCurrentStimulusIdx(ISOPTER_ORDER.indexOf('III4e'))
      currentStimulusRef.current = 'III4e'
    } else {
      thresholdModeRef.current = false
      initGrid(ISOPTER_ORDER[0])
      setCurrentStimulusIdx(0)
      currentStimulusRef.current = ISOPTER_ORDER[0]
    }
    setPhase('countdown')
    setCountdown(3)
  }, [thresholdMode, initGrid, enterFullscreen, getMaxExtentDeg, getScreenAreaDeg2, targetHexagons, pixelsPerDegree, fixationXY.x])

  // ---------- countdown ----------
  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      setPhase('testing')
      phaseRef.current = 'testing'
      if (!startedTrackedRef.current) {
        startedTrackedRef.current = true
        testStartedAtRef.current = Date.now()
        trackEvent('test_started', getDeviceId(), { testType: 'static', eye }).catch(() => {})
      }
      setTimeout(() => dispatchNext(), 500)
      return
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown, dispatchNext, eye])

  // ---------- start next level ----------
  const startNextLevel = useCallback(() => {
    initGrid(currentStimulusRef.current)
    enterFullscreen()
    setPhase('countdown')
    setCountdown(3)
  }, [initGrid, enterFullscreen])

  // ---------- cleanup on unmount ----------
  useEffect(() => {
    return () => {
      clearAllTimeouts()
      if (startedTrackedRef.current && !completedTrackedRef.current) {
	        // The abort event needs the latest tested-points ref at unmount.
	        // eslint-disable-next-line react-hooks/exhaustive-deps
	        const tested = Array.from(testedPointsRef.current.values())
	        const durationSeconds = getTestDurationSeconds()
	        trackEvent('test_aborted', getDeviceId(), {
	          testType: 'static', eye, phase: phaseRef.current,
	          points: String(tested.length),
	          detected: String(tested.filter(p => p.status === 'seen').length),
	          ...(durationSeconds != null ? { durationSeconds: String(durationSeconds) } : {}),
	        }).catch(() => {})
	      }
	    }
	  }, [clearAllTimeouts, eye, getTestDurationSeconds])

  // Fire test_completed when results screen is reached
	  useEffect(() => {
	    if (phase === 'results' && startedTrackedRef.current && !completedTrackedRef.current) {
	      completedTrackedRef.current = true
	      const durationSeconds = getTestDurationSeconds()
	      trackEvent('test_completed', getDeviceId(), {
	        testType: 'static', eye,
	        points: String(results.length),
	        detected: String(results.filter(p => p.detected).length),
	        ...(durationSeconds != null ? { durationSeconds: String(durationSeconds) } : {}),
	      }).catch(() => {})
	    }
	  }, [phase, eye, results, getTestDurationSeconds])

  // ---------- wrap onDone ----------
  const handleDone = () => {
    exitFullscreen()
    onDone()
  }

  // ---------- save ----------
  const handleSave = () => {
    const catchTrials = catchTrialRef.current
    // Threshold mode doesn't run catch trials, so the reliability fields would
    // read as "0 false-positives out of 0 presented" and be misread downstream
    // as perfect reliability. Omit the block entirely in threshold mode.
    const reliabilityIndices = thresholdMode
      ? undefined
      : {
          catchTrialsPresented: catchTrials.length,
          catchTrialsFalsePositive: catchTrials.filter((c) => c.detected).length,
          falsePositiveIsiPresses: fpIsiPressesRef.current,
          truePositiveResponses: truePositivesRef.current,
        }
    const result: TestResult = {
      id: crypto.randomUUID(),
      eye,
      date: new Date().toISOString(),
      points: results,
	      isopterAreas: calcIsopterAreas(results),
	      calibration,
	      testType: 'static',
	      testMode: thresholdMode ? 'threshold' : 'suprathreshold',
	      durationSeconds: getTestDurationSeconds(),
      ...(reliabilityIndices ? { reliabilityIndices } : {}),
	    }
    saveResult(result)
    setSavedId(result.id)
  }

  // ---------- computed ----------
  const completedTasks = visiblePoints.length
  const currentStim = STIMULI[ISOPTER_ORDER[currentStimulusIdx]]
  const unseenCount = visiblePoints.filter(p => p.status === 'unseen').length
  // Per-round progress for the fixation ring (resets each stimulus level)
  const roundDone = Math.max(0, totalPoints - remainingCount)
  const roundProgress = totalPoints > 0 ? Math.min(1, roundDone / totalPoints) : 0

  // ==================== RENDER ====================

  if (phase === 'instructions') {
    return (
      <div className={`min-h-screen ${bgClass} text-white flex items-center justify-center p-6`}>
        <main className="max-w-md space-y-6 text-center">
          <h1 className="text-2xl font-semibold">
            {eye === 'right' ? 'Right' : 'Left'} eye — static test
          </h1>

          <div className="relative w-full h-40 bg-gray-900 rounded-xl flex items-center justify-center overflow-hidden">
            <div className="w-2 h-2 rounded-full bg-yellow-400 z-10" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-3 h-3 rounded-full bg-white absolute animate-ping" style={{ left: '30%', top: '40%', animationDelay: '0s', animationDuration: '2s' }} />
              <div className="w-3 h-3 rounded-full bg-white absolute animate-ping" style={{ left: '60%', top: '30%', animationDelay: '0.5s', animationDuration: '2s' }} />
              <div className="w-3 h-3 rounded-full bg-white absolute animate-ping" style={{ left: '70%', top: '55%', animationDelay: '1s', animationDuration: '2s' }} />
              <div className="w-3 h-3 rounded-full bg-white absolute animate-ping" style={{ left: '25%', top: '65%', animationDelay: '1.5s', animationDuration: '2s' }} />
            </div>
            <span className="absolute bottom-2 text-xs text-gray-600 z-10">
              ~{targetHexagons} test points per level
            </span>
          </div>

          <div className="text-left space-y-3 text-gray-300">
            <p>1. Cover your <strong>{eye === 'right' ? 'left' : 'right'} eye</strong></p>
            <p>2. Stare at the <span className="text-yellow-400">yellow dot</span> — don't look away</p>
            <p>3. Dots will <strong>flash briefly</strong> at random positions</p>
            <p>
              4. Press <kbd className="px-2 py-0.5 bg-gray-800 rounded text-sm">Space</kbd> or{' '}
              <strong>tap</strong> when you see a dot
            </p>
            <p>5. Unseen dots stay as <span className="text-red-400">red markers</span> — connected ones form blind spot regions</p>
          </div>

          <div className="text-xs text-gray-500 bg-gray-900 rounded-lg p-3 text-left space-y-2">
            <p className="font-medium text-gray-400">How it works:</p>
            <p>~{targetHexagons} hexagons cover your visual field at each brightness level. Areas you can't see are excluded in later rounds, so the remaining area gets re-tiled with {targetHexagons} fresh points at higher density. Isolated misses are automatically retested.</p>
          </div>

          <HeadGuide eye={eye} viewingDistanceCm={calibration.viewingDistanceCm} />

          {/* Settings */}
          <div className="space-y-3 text-left">
            <div>
              <div className="flex items-center justify-between text-sm mb-1.5">
                <span className="text-gray-400">Precision</span>
                <span className="text-gray-500 font-mono text-xs">{targetHexagons} hexagons</span>
              </div>
              <div className="flex bg-gray-900 rounded-lg p-1 gap-1">
                {[
                  { n: 50, label: 'Fast', time: '~4 min' },
                  { n: 100, label: 'Standard', time: '~8 min' },
                  { n: 200, label: 'High', time: '~15 min' },
                ].map(opt => (
                  <button
                    key={opt.n}
                    onClick={() => setTargetHexagons(opt.n)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      targetHexagons === opt.n
                        ? 'bg-green-600 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-gray-800'
                    }`}
                  >
                    <span className="block">{opt.label}</span>
                    <span className="block text-[9px] opacity-60">{opt.n} pts · {opt.time}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between text-sm mb-1.5">
                <span className="text-gray-400">Speed</span>
              </div>
              <div className="flex bg-gray-900 rounded-lg p-1 gap-1">
                {([
                  { key: 'relaxed' as const, label: 'Relaxed', desc: 'more time' },
                  { key: 'normal' as const, label: 'Normal', desc: 'default' },
                  { key: 'fast' as const, label: 'Fast', desc: 'experienced' },
                ]).map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => setSpeed(opt.key)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      speed === opt.key
                        ? 'bg-green-600 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-gray-800'
                    }`}
                  >
                    <span className="block">{opt.label}</span>
                    <span className="block text-[9px] opacity-60">{opt.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-start gap-2 mt-4 cursor-pointer">
              <input
                type="checkbox"
                checked={thresholdMode}
                onChange={(e) => setThresholdMode(e.target.checked)}
                className="mt-1"
              />
              <span className="text-sm">
                <span className="font-medium text-zinc-100">Threshold mode (experimental)</span>
                <span className="block text-zinc-400 mt-0.5">
                  Instead of showing each Goldmann level, this estimates the exact
                  sensitivity (in decibels) at each location using a short 4-2 dB
                  staircase. Takes longer per point but produces a real dB map like
                  clinical static perimetry. Uses stimulus size III.
                </span>
              </span>
            </label>
          </div>

          <p className="text-xs text-gray-500">
            Self-monitoring tool, not a clinical diagnosis. Always consult your ophthalmologist.
          </p>
          <button
            onClick={startTest}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >
            Ready
          </button>
          <button onClick={handleDone} className="text-gray-500 hover:text-gray-300 text-sm">
            Cancel
          </button>
        </main>
      </div>
    )
  }

  if (phase === 'countdown') {
    return (
      <div
        className={`min-h-screen ${bgClass} text-white select-none cursor-none relative overflow-hidden`}
        onTouchStart={e => e.preventDefault()}
      >
        <div
          className={`absolute ${fixDotSize} rounded-full bg-yellow-400`}
          style={{
            top: '50%',
            left: '50%',
            marginLeft: fixDotOffset + fixationXY.x,
            marginTop: fixDotOffset + fixationXY.y,
          }}
        />
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
    return (
      <div className={`min-h-screen ${bgClass} text-white flex items-center justify-center select-none p-6`}>
        <main className="text-center space-y-6 max-w-sm w-full">
          <h1 className="text-2xl font-semibold">Paused</h1>
          <p className="text-gray-400 text-sm">
            {completedTasks} / {totalPoints} tested · {unseenCount} unseen
          </p>
          <p className="text-gray-500 text-xs">
            Level: {currentStim.label}
          </p>

          <div className="space-y-3 pt-2">
            <button
              onClick={resume}
              className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
            >
              Resume
            </button>
            <button
              onClick={() => {
                const testPoints = scatterToTestPoints(testedPointsRef.current)
                if (testPoints.length > 0) {
                  setResults(testPoints)
                  setPhase('results')
                } else {
                  handleDone()
                }
              }}
              className="w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
            >
              Stop test &amp; view results
            </button>
            <button onClick={handleDone} className="text-gray-500 hover:text-gray-300 text-sm">
              Quit without saving
            </button>
          </div>

          <p className="text-xs text-gray-600">
            Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Esc</kbd> or <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Space</kbd> to resume
          </p>
        </main>
      </div>
    )
  }

  if (phase === 'level-done') {
    const currentIdx = ISOPTER_ORDER.indexOf(currentStimulusRef.current)
    const nextStim = STIMULI[currentStimulusRef.current]
    const justDoneKey = currentIdx > 0 ? ISOPTER_ORDER[currentIdx - 1] : currentStimulusRef.current
    const prevStim = STIMULI[justDoneKey]
    const levelPoints = Array.from(testedPointsRef.current.values()).filter(p => p.stimulus === justDoneKey)
    const levelSeen = levelPoints.filter(p => p.status === 'seen').length
    const levelUnseen = levelPoints.filter(p => p.status === 'unseen').length

    return (
      <div className={`min-h-screen ${bgClass} text-white p-6 overflow-y-auto`}>
        <main className="max-w-lg mx-auto space-y-6 pb-12 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-green-600/20 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <div className="space-y-2">
            <h1 className="text-xl font-semibold">{prevStim.label} complete</h1>
            <p className="text-gray-400 text-sm">
              {levelPoints.length} points tested · {levelSeen} seen · {levelUnseen} unseen
            </p>
          </div>

          <div className="relative bg-gray-900 rounded-xl overflow-hidden" style={{ aspectRatio: '1' }}>
            <svg viewBox="0 0 400 400" className="w-full h-full" aria-hidden="true">
              {[10, 20, 30, 40, 50].filter(r => r <= maxEccentricityDeg).map(r => (
                <circle
                  key={r}
                  cx={200}
                  cy={200}
                  r={r * (180 / maxEccentricityDeg)}
                  fill="none"
                  stroke="#1e293b"
                  strokeWidth={0.5}
                />
              ))}
              <line x1={200} y1={20} x2={200} y2={380} stroke="#1e293b" strokeWidth={0.5} />
              <line x1={20} y1={200} x2={380} y2={200} stroke="#1e293b" strokeWidth={0.5} />

              {Array.from(testedPointsRef.current.values())
                .filter(p => p.stimulus !== justDoneKey)
                .map(p => {
                  const scale = 180 / maxEccentricityDeg
                  const cx = 200 + p.xDeg * scale
                  const cy = 200 - p.yDeg * scale
                  const levelIdx = ISOPTER_ORDER.indexOf(p.stimulus)
                  const dotR = Math.max(0.6, 2.5 - levelIdx * 0.4)
                  return (
                    <circle
                      key={`prev-${p.key}`}
                      cx={cx}
                      cy={cy}
                      r={dotR}
                      fill={p.status === 'unseen' ? '#7f1d1d' : (STIMULI[p.stimulus]?.color ?? '#334155')}
                      opacity={p.status === 'unseen' ? 0.4 : 0.15}
                    />
                  )
                })}

              {levelPoints.map(p => {
                const scale = 180 / maxEccentricityDeg
                const cx = 200 + p.xDeg * scale
                const cy = 200 - p.yDeg * scale
                return (
                  <circle
                    key={p.key}
                    cx={cx}
                    cy={cy}
                    r={3}
                    fill={p.status === 'unseen' ? '#ef4444' : '#22c55e'}
                    opacity={p.status === 'unseen' ? 0.85 : 0.55}
                  />
                )
              })}

              <circle cx={200} cy={200} r={3} fill="#fbbf24" />
            </svg>
          </div>

          <div className="flex items-center justify-center gap-4 flex-wrap text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500" /> Seen
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-red-500" /> Unseen
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-gray-600 opacity-40" /> Previous levels
            </span>
          </div>

          <div className="bg-gray-900 rounded-xl p-4 space-y-2 text-sm text-left">
            <p className="text-gray-400">
              Next: <span className="text-white font-medium">{nextStim.label}</span>
              {' '}<span className="text-gray-500">({nextStim.sizeDeg < 0.5 ? 'smaller' : 'standard'} dot, {nextStim.intensityFrac < 1 ? 'dimmer' : 'full brightness'})</span>
            </p>
            <p className="text-gray-500 text-xs">
              Blind spots from brighter levels are excluded. The remaining visible area gets a fresh grid of ~{targetHexagons} points at higher density.
            </p>
          </div>

          <button
            onClick={startNextLevel}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >
            Start {nextStim.label}
          </button>

          <button
            onClick={() => finishTest()}
            className="text-gray-500 hover:text-gray-300 text-sm"
          >
            Skip remaining levels — view results now
          </button>
        </main>
      </div>
    )
  }

  if (phase === 'results') {
    if (onComplete) {
      onComplete(results)
      return null
    }

    const areas = calcIsopterAreas(results)
    const measuredDbPoints = thresholdMode
      ? results
          .filter(p => p.thresholdDb != null)
          .map(p => ({
            meridianDeg: p.meridianDeg,
            eccentricityDeg: p.eccentricityDeg,
            db: p.thresholdDb!,
          }))
      : []

    if (!savedId && results.length > 0) {
      handleSave()
    }

    return (
      <div className={`min-h-screen ${bgClass} text-white p-6 overflow-y-auto`}>
        <main className="max-w-lg mx-auto space-y-6 pb-12">
          <h1 className="text-2xl font-semibold text-center">Results</h1>
          <p className="text-center text-xs text-gray-500">Tom static test · {formatEyeLabel(eye)}</p>
          {savedId && (
            <p className="text-center text-green-400 text-xs">
              Saved automatically — this result is now available on the Results page.
            </p>
          )}
          {thresholdMode ? (
            <SensitivityMap
              points={measuredDbPoints}
              eye={eye}
              maxEccentricity={maxEccentricityDeg}
              size={Math.min(600, window.innerWidth - 48)}
              source="measured"
            />
          ) : (
            <>
              <VisualFieldMap
                points={results}
                eye={eye}
                maxEccentricity={maxEccentricityDeg}
                size={Math.min(600, window.innerWidth - 48)}
                calibration={calibration}
                enableVerify
              />
              <SensitivityMap
                points={deriveDbFromSuprathreshold(results)}
                eye={eye}
                maxEccentricity={maxEccentricityDeg}
                size={Math.min(600, window.innerWidth - 48)}
                source="derived"
              />
            </>
          )}
          {!thresholdMode && (
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
          )}
          <ClinicalDisclaimer variant="results" />
          {!thresholdMode && (
            <>
              <Interpretation
                points={results}
                areas={areas}
                maxEccentricityDeg={maxEccentricityDeg}
                calibration={calibration}
                reliabilityIndices={{
                  catchTrialsPresented: catchTrialRef.current.length,
                  catchTrialsFalsePositive: catchTrialRef.current.filter(c => c.detected).length,
                  falsePositiveIsiPresses: fpIsiPressesRef.current,
                  truePositiveResponses: truePositivesRef.current,
                }}
              />
              <ScenarioOverlay userPoints={results} userAreas={areas} maxEccentricity={maxEccentricityDeg} />
            </>
          )}
          {!showVisionSim ? (
            <button
              onClick={() => setShowVisionSim(true)}
              className="w-full py-3 bg-gray-900 hover:bg-gray-800 rounded-xl font-medium transition-colors border border-gray-800 hover:border-gray-700 text-sm"
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
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
              <VisionSimulator points={results} eye={eye} maxEccentricity={maxEccentricityDeg} />
            </div>
          )}
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
                  points: results,
	                  isopterAreas: areas,
	                  calibration,
	                  testType: 'static',
	                  testMode: thresholdMode ? 'threshold' : 'suprathreshold',
	                  durationSeconds: getTestDurationSeconds(),
	                }
                exportTrackedResultPDF(result)
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

  // ==================== ACTIVE TEST ====================
  return (
    <div
      className={`min-h-screen ${bgClass} select-none cursor-none relative overflow-hidden`}
      role="application"
      aria-label={`Visual field test in progress for ${eye} eye. Press Space or tap when you see a dot.`}
      onPointerDown={handlePointerDown}
    >
      {/* Persistent dots for unseen points */}
      {visiblePoints.filter(p => p.status === 'unseen').map(p => {
        const screenX = window.innerWidth / 2 + fixationXY.x + degToPx(p.xDeg, calibration)
        const screenY = window.innerHeight / 2 + fixationXY.y - degToPx(p.yDeg, calibration)

        return (
          <div
            key={p.key}
            className="absolute rounded-full pointer-events-none"
            style={{
              left: screenX - 2,
              top: screenY - 2,
              width: 4,
              height: 4,
              backgroundColor: '#7f1d1d',
              opacity: 0.15,
              zIndex: 4,
            }}
          />
        )
      })}

      {/* Grid overlay (toggle with G key) */}
      {showGrid && currentGridRef.current.map(p => {
        const screenX = window.innerWidth / 2 + fixationXY.x + degToPx(p.xDeg, calibration)
        const screenY = window.innerHeight / 2 + fixationXY.y - degToPx(p.yDeg, calibration)
        const isTested = testedPointsRef.current.has(p.key)
        const tp = testedPointsRef.current.get(p.key)
        return (
          <div
            key={`grid-${p.key}`}
            className="absolute rounded-full pointer-events-none"
            style={{
              left: screenX - 1.5,
              top: screenY - 1.5,
              width: 3,
              height: 3,
              backgroundColor: isTested ? (tp?.status === 'seen' ? '#22c55e' : '#ef4444') : '#334155',
              opacity: isTested ? 0.3 : 0.15,
              zIndex: 3,
            }}
          />
        )
      })}

      {/* Phase & progress indicator */}
      <div
        className="absolute pointer-events-none text-center"
        style={{ top: 12, left: '50%', transform: 'translateX(-50%)' }}
      >
        <span className="text-xs text-gray-600" aria-live="polite">
          {phaseRef.current === 'retest' ? '🔄 Retesting suspicious' : 'Testing'} · {currentStim.label} · {roundDone}/{totalPoints}{unseenCount > 0 ? ` · ${unseenCount} unseen` : ''}{showGrid ? ' · [G] grid' : ''}
        </span>
      </div>

      {/* Progress ring */}
      {totalPoints > 0 && !isMobileTest && (
        <svg
          className="absolute pointer-events-none"
          aria-hidden="true"
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
            strokeDashoffset={`${2 * Math.PI * 8 * (1 - roundProgress)}`}
            transform="rotate(-90 10 10)"
            strokeLinecap="round"
            opacity={0.5}
          />
        </svg>
      )}

      {/* Fixation dot */}
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
          zIndex: 10,
        }}
      />

      {/* Active stimulus dot */}
      <div
        ref={stimulusRef}
        className="absolute rounded-full bg-white"
        style={{ top: '50%', left: '50%', width: 6, height: 6, opacity: 0, willChange: 'transform', zIndex: 5 }}
      />
      {/* Second stimulus dot for burst mode */}
      <div
        ref={stimulus2Ref}
        className="absolute rounded-full bg-white"
        style={{ top: '50%', left: '50%', width: 6, height: 6, opacity: 0, willChange: 'transform', zIndex: 5 }}
      />

      {/* Fixation-loss alert: fires when patient responds to a blindspot catch trial */}
      {showFixationLossAlert && (
        <div
          className="absolute top-[60%] left-1/2 -translate-x-1/2 px-6 py-3 bg-orange-600 text-white rounded-lg font-semibold text-lg shadow-xl pointer-events-none z-30"
          role="alert"
          aria-live="polite"
        >
          {advanced.fixationAlertMessage}
        </div>
      )}
    </div>
  )
}
