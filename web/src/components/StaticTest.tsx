/**
 * Static perimetry — HFA-style threshold test.
 *
 * Runs a 4-2 dB staircase at every location of a standard clinical grid
 * (24-2 by default; 30-2 or 10-2 selectable in advanced settings) and
 * returns a per-point threshold map.
 *
 * Design notes:
 *
 * - **No more hex grid.** The earlier revision built its own density-
 *   weighted hex grid and ran a V4e→I2e Goldmann sweep on top. That
 *   combination was non-standard and, crucially, put lots of points out
 *   in the far periphery where RP users can't see anything — the first
 *   round of the test felt like "I'm blind, this app is broken". The
 *   HFA 24-2 pattern is the clinical standard for exactly this reason:
 *   every point is inside a healthy eye's reliable detection range.
 *
 * - **Start bright, walk dimmer.** `PRIOR_DB = 0` (full brightness) at
 *   every location. First presentation is obviously visible on any
 *   consumer screen; the staircase walks dimmer from there. Clinical
 *   HFAs start near 25 dB, but they run on calibrated bowls with known
 *   luminance; we can't rely on that on an uncalibrated LCD.
 *
 * - **Rescue trial after 5 consecutive misses.** Round-robin scheduling
 *   means peripheral points (where RP loss concentrates) get painted in
 *   runs; five straight misses is demoralising and the user starts to
 *   doubt the test. When the counter hits 5, the next presentation is
 *   forced to a central pending point at V4e (largest Goldmann size) and
 *   full brightness. Almost guaranteed to be seen; the outcome does NOT
 *   feed any staircase (would corrupt the dB estimate). Purely a morale
 *   anchor.
 *
 * - **Feedback on fixation.** Red flash on miss, green on seen. RP users
 *   can't read top-of-screen text while fixating — the coloured
 *   fixation dot is the entire status UI during the run.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { CalibrationData, ResultQualityMetrics, StoredEye, TestPoint, TestResult } from '../types'
import { STIMULI } from '../types'
import { SensitivityMap } from './SensitivityMap'
import { SavePrompt } from './SavePrompt'
import { WhatsAppShareButton } from './WhatsAppShareButton'
import { APP_DOMAIN } from '../branding'
import { dbToOpacity } from '../sensitivity'
import {
  initStaircase,
  stepStaircase,
  type StaircaseState,
} from '../staircase'
import { VisionSimulator } from './VisionSimulator'
import { saveResult, saveSurvey, hasSurveyForResult, hasBeenPromptedForFeedback, markFeedbackPrompted, getDeviceId, getDeviceInfo } from '../storage'
import { useAuth } from '../AuthContext'
import { trackEvent, trackEventBeacon, shareAnonymousVFResult } from '../api'
import { exportTrackedResultPDF } from '../pdfExportTracking'
import { PostTestSurvey } from './PostTestSurvey'
import type { SurveyResponse } from './PostTestSurvey'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'
import { ScenarioOverlay } from './ScenarioOverlay'
import { calcIsopterAreas } from '../isopterCalc'
import { STATIC_TEST } from '../constants'
import { formatEyeLabel } from '../eyeLabels'
import { HeadGuide } from './HeadGuide'
import { degToPx } from '../geometry'
import { stimulusDisplayColor } from '../stimulusDisplay'
import { SPEED_PRESETS } from '../testDefaults'
import { useAdvancedSettings } from '../advancedSettings'
import { useStudyMode } from '../studyMode'
import {
  getStaticGrid,
  type GridPoint,
  type StaticGridPattern,
} from '../grids'
import { summarizeThresholdPoints, thresholdSummaryToMeta } from '../thresholdSummary'
import { PositionCheckOverlay } from './PositionCheckOverlay'
import {
  buildNativeProvenance,
  buildProtocolSnapshot,
  buildQualityMetrics,
  buildStudyEventMeta,
  buildStudyMetadata,
  captureDeviceMetadata,
} from '../resultMetadata'

const { MIN_RESPONSE_MS } = STATIC_TEST

/** Trigger a rescue trial after this many consecutive unseen presentations. */
const RESCUE_AFTER_MISSES = 5

/** Starting dB for every staircase. 0 = maximum on-screen brightness. */
const PRIOR_DB = 0

/** localStorage key guarding against double-upload of an anonymous share. */
const sharedFlagKey = (resultId: string) => `vfc-shared-result-${resultId}`

// 'position-check' is a one-shot pre-flight fired when the user taps Ready
// in the instructions phase. The patient has just read the sitting
// instructions (HeadGuide + "cover your X eye, sit at Y cm"), so the
// check runs without any additional navigation and a pass lands them
// straight in the countdown.
type Phase = 'instructions' | 'position-check' | 'countdown' | 'testing' | 'paused' | 'results'

// Mobile keyboard-less devices don't have a Space key, so the
// "press Space" copy in the instructions and pause screens is just
// noise there. Computed once at module load — orientation doesn't
// change whether the device has a hardware keyboard.
const isMobileDevice = typeof navigator !== 'undefined'
  && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  && navigator.maxTouchPoints > 0

interface Props {
  eye: StoredEye
  calibration: CalibrationData
  extendedField: boolean
  onDone: () => void
  onComplete?: (points: TestPoint[]) => void
  /** Timing preset selected from the home-screen toggle. Defaults to
   *  'normal' (the faster pace — the new default). 'slow' uses longer
   *  timings and more staircase reversals. An explicit Advanced
   *  Settings speed-preset override still wins over this prop. */
  speedMode?: 'normal' | 'slow'
}

export function StaticTest({ eye, calibration, onDone, onComplete, speedMode = 'normal' }: Props) {
  const { user, syncResults } = useAuth()
  const { pixelsPerDegree, maxEccentricityDeg, fixationOffsetPx } = calibration

  // Fixation-dot sizing — fixed px so the countdown dot and the test-phase
  // dot match size, and the first flashFixation() call doesn't visibly
  // resize it.
  const fixDotRestPx = 8
  const fixDotRestOffset = -(fixDotRestPx / 2)
  const fixDotSize = 'w-3 h-3'
  const fixDotOffset = -6

  // ---------- advanced settings ----------
  const advanced = useAdvancedSettings()
  const studyMode = useStudyMode()
  const gridPattern: StaticGridPattern = advanced.staticGridPattern
  const customGrid = advanced.customGrid
  // Ref mirror so tracking callbacks (unmount cleanup, async trackEvent)
  // can read the grid pattern without adding it to their deps and causing
  // spurious re-runs.
  const gridPatternRef = useRef<StaticGridPattern>(gridPattern)
  useEffect(() => { gridPatternRef.current = gridPattern }, [gridPattern])
  const bgClass =
    advanced.backgroundShade === 'light'
      ? 'bg-gray-400'
      : advanced.backgroundShade === 'medium'
        ? 'bg-gray-700'
        : 'bg-gray-950'

  // Speed preset for stimulus timing. Advanced-settings override wins
  // for the four timing fields; `reversalsRequired` is always taken
  // from the home-screen speed toggle because the override UI does not
  // expose it (clinical-reliability knob, not a pacing knob).
  const sp = advanced.speedPreset.override
    ? {
        stimulusMs: advanced.speedPreset.stimulusMs,
        responseMs: advanced.speedPreset.responseMs,
        gapMinMs: advanced.speedPreset.gapMinMs,
        gapMaxMs: advanced.speedPreset.gapMaxMs,
        reversalsRequired: SPEED_PRESETS[speedMode].reversalsRequired,
      }
    : SPEED_PRESETS[speedMode]

  const fixationXY = { x: fixationOffsetPx, y: 0 }

  // ---------- grid coverage ----------
  // The HFA grids are defined in visual-angle degrees (±27° for 24-2,
  // ±30° for 30-2, ±10° for 10-2). When `maxEccentricityDeg` — the field
  // actually reachable on the calibrated screen at the current viewing
  // distance — is smaller than the grid's outermost radius, those outer
  // locations cannot be presented. Filter them out rather than firing
  // stimuli off-screen (which would otherwise converge to a bogus "not
  // seen" for the patient).
  const gridCoverage = useMemo(() => {
    const fullGrid = getStaticGrid(
      gridPattern,
      eye,
      gridPattern === 'custom' ? customGrid : undefined,
    )
    const fitting = fullGrid.filter(p => {
      const r = Math.sqrt(p.xDeg * p.xDeg + p.yDeg * p.yDeg)
      return r <= maxEccentricityDeg
    })
    return {
      totalLocations: fullGrid.length,
      grid: fitting,
      dropped: fullGrid.length - fitting.length,
    }
  }, [gridPattern, eye, customGrid, maxEccentricityDeg])

  // ---------- phase ----------
  const [phase, setPhase] = useState<Phase>('instructions')
  const [countdown, setCountdown] = useState(3)
  const phaseRef = useRef<Phase>('instructions')
  useEffect(() => { phaseRef.current = phase }, [phase])
  const pausedPhaseRef = useRef<Phase>('testing')

  // ---------- test state ----------
  const gridRef = useRef<GridPoint[]>([])
  const queueRef = useRef<GridPoint[]>([])
  const staircasesRef = useRef<Map<string, StaircaseState>>(new Map())
  const currentPointRef = useRef<GridPoint | null>(null)
  const currentStaircaseKeyRef = useRef<string | null>(null)
  const thresholdResultsRef = useRef<TestPoint[]>([])

  // Progress: total points + number of staircases still running. Updated
  // as staircases finish so the ring animates smoothly.
  const [totalPoints, setTotalPoints] = useState(0)
  const [, setRemainingCount] = useState(0)
  // Trial counter exists only to trigger a re-render each presentation —
  // the progress ring reads its real value from `staircasesRef`.
  const [trialsDone, setTrialsDone] = useState(0)

  // Rescue-trial state.
  const consecutiveMissesRef = useRef(0)
  const rescueTrialRef = useRef(false)
  // Count of rescue trials actually fired — surfaced in telemetry meta so
  // we can tell whether morale-anchor trials are kicking in a lot (bad
  // sign: test is demoralising) vs. rarely (fine).
  const rescueFiredRef = useRef(0)

  // ---------- timing / DOM ----------
  const stimulusStartRef = useRef(0)
  const respondedRef = useRef(false)
  const delayTimeoutRef = useRef<ReturnType<typeof setTimeout>>(0 as unknown as ReturnType<typeof setTimeout>)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout>>(0 as unknown as ReturnType<typeof setTimeout>)
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout>>(0 as unknown as ReturnType<typeof setTimeout>)

  const fixationDotRef = useRef<HTMLDivElement>(null)
  const stimulusRef = useRef<HTMLDivElement>(null)

  // ISI (false-positive) guard: pressing during the gap between stimuli.
  const isiActiveRef = useRef(false)
  const fpIsiPressesRef = useRef(0)

  // ---------- results ----------
  const [results, setResults] = useState<TestPoint[]>([])
  const [savedId, setSavedId] = useState<string | null>(null)
  // Keep the built TestResult around so we can retry persistence if the
  // user signs in *after* finishing the test. saveResult no-ops for
  // anonymous users.
  const lastResultRef = useRef<TestResult | null>(null)
  const [showVisionSim, setShowVisionSim] = useState(false)
  const [surveyDone, setSurveyDone] = useState(false)
  // Active-prompt feedback modal — fires once per device, on either
  // Done or Export PDF. `'done'` runs handleDone() on close; `'pdf'`
  // closes the modal in place so the user keeps seeing the results.
  const [feedbackTrigger, setFeedbackTrigger] = useState<'done' | 'pdf' | null>(null)
  // Anonymous-share state for the opt-in "Share to help improve" button.
  // Separate from `savedId` (local save) — "shared" means uploaded to the
  // server for maintainer debugging, which is opt-in and privacy-policy-
  // gated. Persisted in localStorage so a refresh doesn't re-offer a
  // result that's already been uploaded.
  const [shareState, setShareState] = useState<'idle' | 'sharing' | 'shared' | 'error'>('idle')

  // ---------- tracking ----------
  const startedTrackedRef = useRef(false)
  const completedTrackedRef = useRef(false)
  const testStartedAtRef = useRef<number | null>(null)
  const getTestDurationSeconds = useCallback(() => {
    const startedAt = testStartedAtRef.current
    return startedAt == null ? undefined : Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  }, [])

  // ---------- helpers ----------
  const clearAllTimeouts = useCallback(() => {
    clearTimeout(delayTimeoutRef.current)
    clearTimeout(hideTimeoutRef.current)
    clearTimeout(responseTimeoutRef.current)
  }, [])

  /** Show a stimulus at (xDeg, yDeg) with the given size (in degrees) and
   *  opacity. Size is used directly rather than via a STIMULI key because
   *  rescue trials need a different size than the III4e staircase. */
  const showStimulus = useCallback(
    (xDeg: number, yDeg: number, sizeDeg: number, opacity: number) => {
      const el = stimulusRef.current
      if (!el) return
      const sizePx = Math.max(4, Math.round(degToPx(sizeDeg, calibration)))
      const screenX = fixationXY.x + degToPx(xDeg, calibration)
      const screenY = fixationXY.y - degToPx(yDeg, calibration)
      el.style.width = `${sizePx}px`
      el.style.height = `${sizePx}px`
      el.style.marginLeft = `${-sizePx / 2 + screenX}px`
      el.style.marginTop = `${-sizePx / 2 + screenY}px`
      // White stimulus — the Goldmann size/opacity encode the level, colour
      // stays constant.
      el.style.backgroundColor = stimulusDisplayColor('III4e')
      el.style.opacity = `${opacity}`
    },
    // calibration stability is sufficient for this ref-only writer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pixelsPerDegree, fixationXY.x, fixationXY.y],
  )

  const hideStimulus = useCallback(() => {
    const el = stimulusRef.current
    if (el) el.style.opacity = '0'
  }, [])

  /** Flash the fixation dot a colour and snap it back to amber. Used for
   *  seen (green) / unseen (red) / false-positive (red, longer) feedback. */
  const flashFixation = useCallback(
    (color: string, durationMs: number) => {
      const dot = fixationDotRef.current
      if (!dot) return
      const flashSize = 12
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
    },
    [fixationXY.x, fixationXY.y, fixDotRestPx, fixDotRestOffset],
  )

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

  // ---------- fullscreen ----------
  const enterFullscreen = useCallback(() => {
    try {
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>
      }
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {})
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
    } catch { /* not supported */ }
    if (typeof window !== 'undefined') window.scrollTo(0, 1)
  }, [])

  const exitFullscreen = useCallback(() => {
    try {
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null
        webkitExitFullscreen?: () => Promise<void>
      }
      if (doc.fullscreenElement && doc.exitFullscreen) doc.exitFullscreen().catch(() => {})
      else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) doc.webkitExitFullscreen()
    } catch { /* not supported */ }
  }, [])

  // ---------- finish ----------
  const finishTest = useCallback(() => {
    exitFullscreen()
    setResults([...thresholdResultsRef.current])
    setPhase('results')
  }, [exitFullscreen])

  // ---------- pick rescue point ----------
  /** Random pending point from the inner ~40% by eccentricity. Central
   *  points are likely inside RP-preserved vision so the rescue flash
   *  feels like a win; picking randomly within that inner band stops the
   *  rescue from always landing on the same 1–2 dots and giving the game
   *  away. Falls back to any pending point if the inner band is empty. */
  const RESCUE_INNER_FRACTION = 0.4
  const pickRescuePendingPoint = useCallback((): GridPoint | null => {
    const pending: Array<{ p: GridPoint; ecc: number }> = []
    for (const p of gridRef.current) {
      const s = staircasesRef.current.get(p.key)
      if (!s || s.done) continue
      pending.push({ p, ecc: Math.hypot(p.xDeg, p.yDeg) })
    }
    if (pending.length === 0) return null
    pending.sort((a, b) => a.ecc - b.ecc)
    const innerCount = Math.max(1, Math.round(pending.length * RESCUE_INNER_FRACTION))
    const inner = pending.slice(0, innerCount)
    return inner[Math.floor(Math.random() * inner.length)].p
  }, [])

  // ---------- present next stimulus ----------
  const presentNext = useCallback(() => {
    if (phaseRef.current !== 'testing') return
    isiActiveRef.current = false

    // Rescue trial?
    const rescue = consecutiveMissesRef.current >= RESCUE_AFTER_MISSES

    let point: GridPoint | null = null
    let sizeDeg: number
    let opacity: number

    if (rescue) {
      point = pickRescuePendingPoint()
      if (!point) {
        // No pending points: we're done.
        finishTest()
        return
      }
      // V4e at full brightness — largest Goldmann size, max opacity. This
      // trial's outcome is NOT fed to any staircase (see response handler).
      rescueTrialRef.current = true
      rescueFiredRef.current += 1
      sizeDeg = STIMULI['V4e'].sizeDeg
      opacity = 1
    } else {
      rescueTrialRef.current = false
      // Round-robin through pending staircases.
      const queue = queueRef.current
      while (queue.length > 0) {
        const candidate = queue.shift()!
        const state = staircasesRef.current.get(candidate.key)
        if (state && !state.done) {
          point = candidate
          queue.push(candidate) // re-queue at back
          break
        }
      }
      if (!point) {
        finishTest()
        return
      }
      const state = staircasesRef.current.get(point.key)
      if (!state) return
      sizeDeg = STIMULI['III4e'].sizeDeg
      opacity = dbToOpacity(state.currentDb)
    }

    currentPointRef.current = point
    currentStaircaseKeyRef.current = point.key
    respondedRef.current = false

    const thePoint = point
    const theSize = sizeDeg
    const theOpacity = opacity
    const theRescue = rescueTrialRef.current
    const delay = sp.gapMinMs + Math.random() * (sp.gapMaxMs - sp.gapMinMs)

    delayTimeoutRef.current = setTimeout(() => {
      if (phaseRef.current !== 'testing') return
      isiActiveRef.current = false
      showStimulus(thePoint.xDeg, thePoint.yDeg, theSize, theOpacity)
      stimulusStartRef.current = performance.now()
      setTrialsDone(n => n + 1)
      hideTimeoutRef.current = setTimeout(() => hideStimulus(), sp.stimulusMs)
      responseTimeoutRef.current = setTimeout(() => {
        if (!respondedRef.current && currentStaircaseKeyRef.current === thePoint.key) {
          hideStimulus()
          flashFixation('#ef4444', 200)
          if (theRescue) {
            // Rescue miss: unusual, but don't feed the staircase. Reset
            // the streak regardless so we don't loop rescues forever.
            consecutiveMissesRef.current = 0
            rescueTrialRef.current = false
          } else {
            consecutiveMissesRef.current += 1
            const s = staircasesRef.current.get(thePoint.key)
            if (!s) return
            const next = stepStaircase(s, false)
            staircasesRef.current.set(thePoint.key, next)
            if (next.done && next.thresholdDb != null) {
              recordThresholdPoint(thePoint, next.thresholdDb)
            }
            setRemainingCount(countPendingStaircases())
          }
          isiActiveRef.current = true
          presentNext()
        }
      }, sp.responseMs)
    }, delay)
    isiActiveRef.current = true
  }, [
    pickRescuePendingPoint,
    finishTest,
    showStimulus,
    hideStimulus,
    flashFixation,
    recordThresholdPoint,
    countPendingStaircases,
    sp.gapMaxMs,
    sp.gapMinMs,
    sp.responseMs,
    sp.stimulusMs,
  ])

  // ---------- response handler ----------
  const handleResponse = useCallback(() => {
    if (phaseRef.current !== 'testing') return
    if (respondedRef.current || !currentPointRef.current) return
    if (stimulusStartRef.current === 0) return

    const elapsed = performance.now() - stimulusStartRef.current
    if (elapsed > sp.responseMs) return
    respondedRef.current = true

    if (elapsed < MIN_RESPONSE_MS) {
      // Too fast — likely a false positive. Count it, ignore, don't step
      // the staircase, don't reset the rescue counter (the trial didn't
      // complete normally).
      flashFixation('#ef4444', 300)
      clearAllTimeouts()
      hideStimulus()
      fpIsiPressesRef.current += 1
      isiActiveRef.current = true
      setTimeout(() => presentNext(), 500)
      return
    }

    flashFixation('#22c55e', 150)
    clearAllTimeouts()
    hideStimulus()

    if (rescueTrialRef.current) {
      // Rescue seen — morale restored, continue. Do NOT step any
      // staircase; the opacity we showed wasn't the staircase's value.
      consecutiveMissesRef.current = 0
      rescueTrialRef.current = false
    } else {
      consecutiveMissesRef.current = 0
      const key = currentStaircaseKeyRef.current
      const state = key != null ? staircasesRef.current.get(key) : undefined
      if (key != null && state) {
        const next = stepStaircase(state, true)
        staircasesRef.current.set(key, next)
        if (next.done && next.thresholdDb != null) {
          const point = gridRef.current.find(p => p.key === key)
          if (point) recordThresholdPoint(point, next.thresholdDb)
        }
        setRemainingCount(countPendingStaircases())
      }
    }
    isiActiveRef.current = true
    presentNext()
  }, [
    flashFixation,
    hideStimulus,
    clearAllTimeouts,
    presentNext,
    recordThresholdPoint,
    countPendingStaircases,
    sp.responseMs,
  ])

  // ---------- pause / resume ----------
  const pauseTest = useCallback(() => {
    if (phaseRef.current === 'testing') {
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
    setTimeout(() => presentNext(), 1000)
  }, [presentNext, enterFullscreen])

  // ---------- keyboard + pointer ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (phaseRef.current === 'testing') pauseTest()
        else if (phaseRef.current === 'paused') resume()
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
    staircasesRef.current.clear()
    thresholdResultsRef.current = []
    consecutiveMissesRef.current = 0
    rescueTrialRef.current = false
    rescueFiredRef.current = 0
    fpIsiPressesRef.current = 0
    isiActiveRef.current = false
    setTrialsDone(0)

    // Use the coverage-filtered grid — points outside the calibrated
    // screen's max eccentricity are already dropped so we never present
    // stimuli the patient couldn't physically see.
    const grid = gridCoverage.grid
    gridRef.current = grid
    for (const p of grid) {
      staircasesRef.current.set(p.key, initStaircase(PRIOR_DB, sp.reversalsRequired))
    }
    // Shuffle so round-robin doesn't crawl row-by-row — distributes trials
    // across the whole field and avoids long runs at one eccentricity.
    const shuffled = [...grid]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    queueRef.current = shuffled
    setTotalPoints(grid.length)
    setRemainingCount(grid.length)
    // Position check first — runs once per test, immediately after Ready.
    // Handoff to countdown happens in handlePositionCheckPass below.
    // Skipped when the advanced toggle is off (default), in which case we
    // jump straight to the countdown.
    if (advanced.initialBlindspotCheck) {
      setPhase('position-check')
    } else {
      setPhase('countdown')
      setCountdown(3)
    }
  }, [enterFullscreen, gridCoverage, sp.reversalsRequired, advanced.initialBlindspotCheck])

  const handlePositionCheckPass = useCallback(() => {
    setPhase('countdown')
    setCountdown(3)
  }, [])

  // ---------- countdown ----------
  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) {
      setPhase('testing')
      phaseRef.current = 'testing'
      if (!startedTrackedRef.current) {
        startedTrackedRef.current = true
        testStartedAtRef.current = Date.now()
        trackEvent('test_started', getDeviceId(), {
          testType: 'static',
          eye,
          ...getDeviceInfo(),
          ...buildStudyEventMeta(studyMode),
        }).catch(() => {})
      }
      setTimeout(() => presentNext(), 500)
      return
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown, presentNext, eye])

  // Dedupe flag — see GoldmannTest for the full rationale. Both pagehide
  // (tab close, hard navigate, bfcache) and React unmount can fire; this
  // ensures only one test_aborted goes out per session.
  const abortDispatchedRef = useRef(false)

  const buildAbortMeta = useCallback((via: 'unmount' | 'pagehide'): Record<string, string> => {
    const durationSeconds = getTestDurationSeconds()
    const summaryMeta = thresholdSummaryToMeta(
      summarizeThresholdPoints(thresholdResultsRef.current),
    )
    return {
      testType: 'static', eye, phase: phaseRef.current,
      testMode: 'threshold',
      speedMode,
      gridPattern: gridPatternRef.current,
      points: String(thresholdResultsRef.current.length),
      detected: String(thresholdResultsRef.current.length),
      rescueFired: String(rescueFiredRef.current),
      fpIsiPresses: String(fpIsiPressesRef.current),
      abortVia: via,
      ...getDeviceInfo(),
      ...buildStudyEventMeta(studyMode),
      ...summaryMeta,
      ...(durationSeconds != null ? { durationSeconds: String(durationSeconds) } : {}),
    }
  }, [eye, getTestDurationSeconds, speedMode, studyMode])

  // pagehide-driven abort: catches tab close / navigate-away that React
  // unmount cleanup misses (those tear down the runtime before the cleanup
  // effect ever runs). Beacon uses fetch+keepalive for survivability.
  useEffect(() => {
    const onPageHide = () => {
      if (abortDispatchedRef.current) return
      if (!startedTrackedRef.current || completedTrackedRef.current) return
      abortDispatchedRef.current = true
      trackEventBeacon('test_aborted', getDeviceId(), buildAbortMeta('pagehide'))
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [buildAbortMeta])

  // ---------- unmount / completion tracking ----------
  useEffect(() => {
    return () => {
      clearAllTimeouts()
      if (
        startedTrackedRef.current
        && !completedTrackedRef.current
        && !abortDispatchedRef.current
      ) {
        abortDispatchedRef.current = true
        trackEvent('test_aborted', getDeviceId(), buildAbortMeta('unmount')).catch(() => {})
      }
    }
  }, [clearAllTimeouts, buildAbortMeta])

  useEffect(() => {
    if (phase === 'results' && startedTrackedRef.current && !completedTrackedRef.current) {
      completedTrackedRef.current = true
      const durationSeconds = getTestDurationSeconds()
      const summaryMeta = thresholdSummaryToMeta(summarizeThresholdPoints(results))
      trackEvent('test_completed', getDeviceId(), {
        testType: 'static', eye,
        testMode: 'threshold',
        speedMode,
        gridPattern: gridPatternRef.current,
        points: String(results.length),
        detected: String(results.length),
        rescueFired: String(rescueFiredRef.current),
        fpIsiPresses: String(fpIsiPressesRef.current),
        ...buildStudyEventMeta(studyMode),
        ...summaryMeta,
        ...(durationSeconds != null ? { durationSeconds: String(durationSeconds) } : {}),
      }).catch(() => {})
    }
  }, [phase, eye, results, getTestDurationSeconds, speedMode, studyMode])

  const handleDone = () => {
    exitFullscreen()
    onDone()
  }

  // Done from the post-test results screen — show the one-shot
  // feedback modal first if we haven't asked on this device yet.
  const handleDoneFromResults = () => {
    if (savedId && !surveyDone && !hasSurveyForResult(savedId) && !hasBeenPromptedForFeedback()) {
      markFeedbackPrompted()
      setFeedbackTrigger('done')
      return
    }
    handleDone()
  }

  const exportPdfAndMaybePrompt = (result: TestResult) => {
    exportTrackedResultPDF(result)
    if (savedId && !surveyDone && !hasSurveyForResult(savedId) && !hasBeenPromptedForFeedback()) {
      markFeedbackPrompted()
      setFeedbackTrigger('pdf')
    }
  }

  const closeFeedbackModal = () => {
    const trigger = feedbackTrigger
    setFeedbackTrigger(null)
    if (trigger === 'done') handleDone()
  }

  const handleFeedbackSubmit = (response: SurveyResponse) => {
    if (savedId) {
      saveSurvey(savedId, response)
      setSurveyDone(true)
    }
    closeFeedbackModal()
  }

  const handleSave = () => {
    // Static points are tagged stimulus='III4e' and `detected=true` for
    // every location where the staircase converged. Running them through
    // calcIsopterAreas produces a III4e-equivalent visible-field area so
    // the ScenarioOverlay (kinetic clinical references keyed on III4e /
    // V4e areas) has something meaningful to compare against. Previously
    // we saved isopterAreas={} which made the scenario picker always
    // land on "Normal" regardless of actual result quality.
    const qualityMetrics: ResultQualityMetrics = {
      falsePositiveIsiPresses: fpIsiPressesRef.current,
      rescueTrialsFired: rescueFiredRef.current,
      truePositiveResponses: results.length,
    }
    const result: TestResult = {
      id: crypto.randomUUID(),
      eye,
      date: new Date().toISOString(),
      points: results,
      isopterAreas: calcIsopterAreas(results),
      calibration,
      testType: 'static',
      testMode: 'threshold',
      durationSeconds: getTestDurationSeconds(),
      protocol: buildProtocolSnapshot({
        studyMode,
        testType: 'static',
        testMode: 'threshold',
        speedMode,
        staticGridPattern: gridPattern,
        advancedSettings: advanced,
      }),
      ...(buildStudyMetadata(studyMode) ? { study: buildStudyMetadata(studyMode) } : {}),
      device: captureDeviceMetadata(),
      provenance: buildNativeProvenance(),
      ...(buildQualityMetrics(qualityMetrics) ? { qualityMetrics: buildQualityMetrics(qualityMetrics) } : {}),
      ...(gridCoverage.dropped > 0
        ? {
            gridCoverage: {
              totalLocations: gridCoverage.totalLocations,
              presentedLocations: gridCoverage.grid.length,
            },
          }
        : {}),
    }
    lastResultRef.current = result
    saveResult(result)
    setSavedId(result.id)
    // If this result was previously shared (unlikely on fresh id, but
    // harmless to check), skip the offer to re-share.
    if (localStorage.getItem(sharedFlagKey(result.id)) === '1') {
      setShareState('shared')
    }
  }

  // If the user signs in after finishing the test (via SavePrompt on the
  // results screen), retry persistence so the just-completed run lands
  // on their new account. saveResult is idempotent by id.
  useEffect(() => {
    if (!user || !lastResultRef.current) return
    saveResult(lastResultRef.current)
    syncResults()
  }, [user, syncResults])

  /** Anonymous upload — opt-in, fires only when the user taps the
   *  "Share anonymous result" button on the results screen. Payload is
   *  the full TestResult JSON; storage key on the server is the device
   *  UUID, not an account. Persist a localStorage flag so a page reload
   *  doesn't offer the same result twice. */
  const handleShareAnonymous = async () => {
    if (!savedId || shareState === 'sharing' || shareState === 'shared') return
    setShareState('sharing')
    const qualityMetrics: ResultQualityMetrics = {
      falsePositiveIsiPresses: fpIsiPressesRef.current,
      rescueTrialsFired: rescueFiredRef.current,
      truePositiveResponses: results.length,
    }
    const result: TestResult = {
      id: savedId,
      eye,
      date: new Date().toISOString(),
      points: results,
      isopterAreas: calcIsopterAreas(results),
      calibration,
      testType: 'static',
      testMode: 'threshold',
      durationSeconds: getTestDurationSeconds(),
      protocol: buildProtocolSnapshot({
        studyMode,
        testType: 'static',
        testMode: 'threshold',
        speedMode,
        staticGridPattern: gridPattern,
        advancedSettings: advanced,
      }),
      ...(buildStudyMetadata(studyMode) ? { study: buildStudyMetadata(studyMode) } : {}),
      device: captureDeviceMetadata(),
      provenance: buildNativeProvenance(),
      ...(buildQualityMetrics(qualityMetrics) ? { qualityMetrics: buildQualityMetrics(qualityMetrics) } : {}),
    }
    try {
      await shareAnonymousVFResult(
        {
          id: result.id,
          eye: result.eye,
          date: result.date,
          data: JSON.stringify(result),
        },
        getDeviceId(),
      )
      localStorage.setItem(sharedFlagKey(result.id), '1')
      setShareState('shared')
    } catch {
      setShareState('error')
    }
  }

  // ==================== RENDER ====================

  if (phase === 'instructions') {
    return (
      <div className={`min-h-screen ${bgClass} text-white flex items-center justify-center p-6`}>
        <main className="max-w-md space-y-6 text-center">
          <h1 className="text-2xl font-semibold">
            {eye === 'right' ? 'Right' : 'Left'} eye — static test
          </h1>

          <HeadGuide
            eye={eye}
            viewingDistanceCm={calibration.viewingDistanceCm}
            mode={isMobileDevice ? 'phone' : 'desktop'}
          />

          <div className="text-left space-y-3 text-gray-300">
            <p>1. Cover your <strong>{eye === 'right' ? 'left' : 'right'} eye</strong></p>
            <p>2. Stare at the <span className="text-yellow-400">yellow dot</span> — don't look away</p>
            <p>3. Dots will <strong>flash briefly</strong> at known test positions</p>
            <p>
              4. {isMobileDevice ? <><strong>Tap</strong> the screen when you see a dot</> : <>Press <kbd className="px-2 py-0.5 bg-gray-800 rounded text-sm">Space</kbd> or <strong>tap</strong> when you see a dot</>}
            </p>
            <p>5. It's <em>normal</em> to miss many flashes — that's how the test finds your threshold</p>
          </div>

          {!isMobileDevice && (
            <p className="text-xs text-gray-500">
              Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-[10px] font-mono text-gray-300">Esc</kbd> any time to pause the test or exit.
            </p>
          )}

          <p className="text-xs text-gray-500">
            Self-monitoring tool, not a clinical diagnosis. Always consult your ophthalmologist.
          </p>

          {gridCoverage.dropped > 0 && (
            <div
              role="alert"
              className="text-left text-sm bg-amber-900/30 border border-amber-600/50 rounded-lg px-4 py-3 text-amber-200"
            >
              <strong className="block mb-1">Grid not fully covered</strong>
              At this viewing distance your screen reaches ±{maxEccentricityDeg.toFixed(0)}° eccentricity, so{' '}
              {gridCoverage.dropped} of {gridCoverage.totalLocations} locations in the{' '}
              {gridPattern === 'custom' ? 'custom' : `HFA ${gridPattern}`} pattern fall outside the display and will be
              skipped. Sit closer to the screen (and recalibrate) to cover more of the pattern.
            </div>
          )}

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

  if (phase === 'position-check') {
    return (
      <PositionCheckOverlay
        skipPrepare
        eye={eye}
        calibration={calibration}
        onPass={handlePositionCheckPass}
      />
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
    // Completed so far = number of staircases that already have a
    // recorded threshold.
    const done = thresholdResultsRef.current.length
    const progressPct = totalPoints > 0 ? (done / totalPoints) * 100 : 0
    return (
      <div className={`min-h-screen ${bgClass} text-white flex items-center justify-center select-none p-6`}>
        <main className="text-center space-y-6 max-w-sm w-full">
          <h1 className="text-2xl font-semibold">Paused</h1>
          <p className="text-gray-400 text-sm">
            {done} / {totalPoints} points measured
          </p>

          {/* Progress bar — matches GoldmannTest pause screen. Teal owns
              forward-motion indicators in this app's palette. */}
          <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-teal transition-all duration-300"
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
                // Always go to the results phase, even when no staircase has
                // converged yet — otherwise the user thinks "view results"
                // silently sent them home. The results screen renders an
                // empty-state when there is nothing to show.
                setResults([...thresholdResultsRef.current])
                setPhase('results')
              }}
              className="w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
            >
              Stop test &amp; view results
            </button>
            <button onClick={handleDone} className="text-gray-500 hover:text-gray-300 text-sm">
              Quit without viewing results
            </button>
          </div>

          {!isMobileDevice && (
            <p className="text-xs text-gray-600">
              Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Esc</kbd> or <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Space</kbd> to resume
            </p>
          )}
        </main>
      </div>
    )
  }

  if (phase === 'results') {
    if (onComplete) {
      onComplete(results)
      return null
    }

    const measuredDbPoints = results
      .filter(p => p.thresholdDb != null)
      .map(p => ({
        meridianDeg: p.meridianDeg,
        eccentricityDeg: p.eccentricityDeg,
        db: p.thresholdDb!,
      }))

    if (!savedId && results.length > 0) {
      handleSave()
    }

    // User hit "Stop & view results" before any location converged. Rather
    // than silently redirecting home, explain why there's nothing to show
    // and give them a clear path back to the home screen.
    if (measuredDbPoints.length === 0) {
      return (
        <div className={`min-h-screen ${bgClass} text-white p-6 overflow-y-auto`}>
          <main className="max-w-lg mx-auto space-y-6 pb-12 text-center">
            <h1 className="text-2xl font-semibold">Results</h1>
            <p className="text-sm text-gray-400">
              {gridPattern === 'custom' ? 'Custom' : `HFA ${gridPattern}`} · {formatEyeLabel(eye)}
            </p>
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 text-sm text-zinc-300 space-y-2 text-left">
              <p className="font-medium text-zinc-100">No measurements yet</p>
              <p className="text-zinc-400 leading-relaxed">
                The static test needs several responses at each location
                before it can estimate a threshold. You stopped the test
                before any location finished, so there's nothing to plot.
                Restart the test to collect data.
              </p>
            </div>
            <button
              onClick={handleDone}
              className="w-full py-3 btn-primary rounded-xl font-medium text-white"
            >
              Back to home
            </button>
          </main>
        </div>
      )
    }

    return (
      <div className={`min-h-screen ${bgClass} text-white p-6 overflow-y-auto`}>
        <main className="max-w-lg mx-auto space-y-6 pb-12">
          <h1 className="text-2xl font-semibold text-center">Results</h1>
          <p className="text-center text-xs text-gray-500">
            {gridPattern === 'custom' ? 'Custom' : `HFA ${gridPattern}`} · {formatEyeLabel(eye)}
          </p>
          {savedId && <SavePrompt />}
          <SensitivityMap
            points={measuredDbPoints}
            eye={eye}
            maxEccentricity={maxEccentricityDeg}
            size={Math.min(600, window.innerWidth - 48)}
          />
          {gridCoverage.dropped > 0 && (
            <p className="text-center text-xs text-amber-400">
              Partial grid coverage: {gridCoverage.grid.length} of {gridCoverage.totalLocations} locations
              presented. Outer points fell outside your screen at this viewing distance.
            </p>
          )}
          <ClinicalDisclaimer variant="results" />
          {/* Clinical comparison — parity with Goldmann and binocular
              results screens. ScenarioOverlay matches on III4e/V4e
              isopter areas; for static tests we derive a III4e-
              equivalent area from the detected grid points above (see
              handleSave) so the picker can pick a meaningful closest
              reference. */}
          <ScenarioOverlay
            userPoints={results}
            userAreas={calcIsopterAreas(results)}
            maxEccentricity={maxEccentricityDeg}
          />
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

          {/* Anonymous share — opt-in only. Keeps the "nothing is sent"
              promise in the privacy policy intact for users who don't tap.
              Uses the same device UUID convention as anonymous surveys. */}
          {savedId && (
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-xs text-zinc-400 space-y-2">
              {shareState === 'idle' && (
                <>
                  <p className="leading-relaxed">
                    Help improve the tool: share this result anonymously.
                    Only the point data, calibration, and a random device ID
                    are uploaded — no name, email, or IP.
                  </p>
                  <button
                    onClick={handleShareAnonymous}
                    className="w-full py-2 bg-gray-800 hover:bg-gray-700 rounded-md text-sm text-gray-200 transition-colors"
                  >
                    Share anonymous result
                  </button>
                </>
              )}
              {shareState === 'sharing' && (
                <p className="text-center text-gray-300">Uploading…</p>
              )}
              {shareState === 'shared' && (
                <p className="text-center text-green-400">
                  Shared — thank you, this helps a lot.
                </p>
              )}
              {shareState === 'error' && (
                <div className="space-y-1">
                  <p className="text-center text-red-300">
                    Upload failed. No data was sent.
                  </p>
                  <button
                    onClick={() => setShareState('idle')}
                    className="w-full py-1.5 bg-gray-800 hover:bg-gray-700 rounded-md text-xs text-gray-200 transition-colors"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
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
                  isopterAreas: calcIsopterAreas(results),
                  calibration,
                  testType: 'static',
                  testMode: 'threshold',
                  durationSeconds: getTestDurationSeconds(),
                }
                exportPdfAndMaybePrompt(result)
              }}
              className="flex-1 py-3 btn-primary rounded-xl font-medium text-white"
            >
              Export PDF
            </button>
            <button
              onClick={handleDoneFromResults}
              className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg font-medium transition-colors"
            >
              Done
            </button>
          </div>
          <WhatsAppShareButton
            message={`I just took a free static visual-field self-test on ${APP_DOMAIN} (${eye === 'right' ? 'right eye / OD' : 'left eye / OS'}). Try it yourself:`}
          />
        </main>

        {feedbackTrigger && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Quick feedback"
            onClick={closeFeedbackModal}
          >
            <div className="w-full max-w-md" onClick={e => e.stopPropagation()}>
              <PostTestSurvey
                onSubmit={handleFeedbackSubmit}
                onSkip={closeFeedbackModal}
              />
            </div>
          </div>
        )}
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
      {/* Fixation-ring progress — the RP user's only in-test UI, so it
          has to live right next to the fixation dot. We blend two
          signals so the ring moves from the very first trial instead
          of sitting at zero until a staircase clocks its first
          reversal (which for a healthy eye can take ~3 presentations
          × 54 points of round-robin):
            • trial-based: trialsDone / (totalPoints × expectedTrials),
              a smooth "time served" estimate that ticks every flash.
            • reversal-based: sum of per-staircase reversal fractions
              (+1 for done), the more accurate signal once walks get
              going.
          Taking the max means the bar never goes backwards and always
          reflects the best available progress measure. Expected trials
          per point ≈ reversalsRequired + 2 warmup trials (matches the
          Dzwiniel 4-reversal budget and our Fast 2-reversal preset). */}
      {totalPoints > 0 && (() => {
        let doneByReversals = 0
        for (const s of staircasesRef.current.values()) {
          doneByReversals += s.done ? 1 : Math.min(1, s.reversals.length / s.reversalsRequired)
        }
        const progressByReversals = doneByReversals / Math.max(1, totalPoints)
        const expectedTrialsPerPoint = sp.reversalsRequired + 2
        const progressByTrials = Math.min(
          1,
          trialsDone / Math.max(1, totalPoints * expectedTrialsPerPoint),
        )
        const ringProgress = Math.min(1, Math.max(progressByReversals, progressByTrials))
        return (
          <svg
            className="absolute pointer-events-none"
            aria-hidden="true"
            style={{
              top: '50%',
              left: '50%',
              marginLeft: -12 + fixationXY.x,
              marginTop: -12 + fixationXY.y,
              width: 24,
              height: 24,
              zIndex: 9,
            }}
            viewBox="0 0 24 24"
          >
            <circle cx={12} cy={12} r={10} fill="none" stroke="#1e293b" strokeWidth={1.5} />
            <circle
              cx={12} cy={12} r={10} fill="none" stroke="#22c55e" strokeWidth={1.5}
              strokeDasharray={`${2 * Math.PI * 10}`}
              strokeDashoffset={`${2 * Math.PI * 10 * (1 - ringProgress)}`}
              transform="rotate(-90 12 12)"
              strokeLinecap="round"
              opacity={0.55}
            />
          </svg>
        )
      })()}

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

      {/* Active stimulus */}
      <div
        ref={stimulusRef}
        className="absolute rounded-full bg-white"
        style={{ top: '50%', left: '50%', width: 6, height: 6, opacity: 0, willChange: 'transform', zIndex: 5 }}
      />
    </div>
  )
}
