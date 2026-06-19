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
import type { CalibrationData, ResultQualityMetrics, RunSpeedMode, StoredEye, TestPoint, TestResult } from '../types'
import { STIMULI } from '../types'
import { HFAResultsView } from './HFAResultsView'
import { PauseScreen } from './PauseScreen'
import { SavePrompt } from './SavePrompt'
import { dbToOpacity } from '../sensitivity'
import {
  initStaircase,
  stepStaircase,
  type StaircaseState,
} from '../staircase'
import { saveResult, saveSurvey, hasSurveyForResult, hasBeenPromptedForFeedback, markFeedbackPrompted, getDeviceId, getDeviceInfo } from '../storage'
import { useAuth } from '../AuthContext'
import { trackEvent, trackEventBeacon } from '../api'
import { exportTrackedResultPDF } from '../pdfExportTracking'
import { PostTestSurvey } from './PostTestSurvey'
import type { SurveyResponse } from './PostTestSurvey'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'
import { calcIsopterAreas } from '../isopterCalc'
import { STATIC_TEST } from '../constants'
import { formatEyeLabel } from '../eyeLabels'
import { HeadGuide } from './HeadGuide'
import { degToPx } from '../geometry'
import { computeVrViewport } from '../vrGeometry'
import { VrTestSurface } from './VrTestSurface'
import { stimulusDisplayColor } from '../stimulusDisplay'
import { SPEED_PRESETS } from '../testDefaults'
import { useAdvancedSettings } from '../advancedSettings'
import { useStudyMode } from '../studyMode'
import { isPhoneLikeDevice } from '../deviceMode'
import { useRemoteInput, REMOTE_RESPONSE_KEYS } from '../remoteInput'
import {
  getStaticGrid,
  type GridPoint,
  type StaticGridPattern,
} from '../grids'
import { summarizeThresholdPoints, thresholdSummaryToMeta } from '../thresholdSummary'
import { useActiveTestGuards, pageLeaveMeta, type PageLeaveInfo } from '../testLifecycle'
import {
  saveResumeSnapshot,
  loadResumeSnapshot,
  clearResumeSnapshot,
  serializeStaircases,
  deserializeStaircases,
  resumeKey,
  isPracticeDone,
  markPracticeDone,
} from '../testResume'
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

// 'position-check' is a one-shot pre-flight fired when the user taps Ready
// in the instructions phase. The patient has just read the sitting
// instructions (HeadGuide + "cover your X eye, sit at Y cm"), so the
// check runs without any additional navigation and a pass lands them
// straight in the countdown.
type Phase = 'instructions' | 'position-check' | 'practice' | 'countdown' | 'testing' | 'paused' | 'results'

/** Number of unscored practice presentations before the real test, so the
 *  user learns the press-when-seen mechanic on guaranteed-visible dots
 *  instead of during scored trials. */
const PRACTICE_TRIALS = 3
/** Easy, central, definitely-on-screen positions for the practice dots
 *  (V4e, full brightness). Kept inside ±6° so they render at any
 *  reasonable calibration without falling off the viewport. */
const PRACTICE_POSITIONS: Array<{ xDeg: number; yDeg: number }> = [
  { xDeg: -6, yDeg: 3 },
  { xDeg: 6, yDeg: 3 },
  { xDeg: 0, yDeg: -6 },
]
/** Neutral cue colour for a too-fast / false-positive press. Replaces the
 *  alarming red (#ef4444) — red was the only red in the run and read as
 *  "you did it wrong" to a user whose genuine early "I saw it" press just
 *  landed a hair too soon. Slate-400 is visible on the dark field without
 *  signalling alarm. */
const NEUTRAL_FLASH = '#94a3b8'

/** Serialisable in-progress snapshot for cross-reload resume. */
interface StaticResumePayload {
  calibrationKey: string
  gridPattern: string
  speedMode: string
  startedAt: number | null
  grid: GridPoint[]
  queue: GridPoint[]
  staircases: Array<[string, StaircaseState]>
  thresholdResults: TestPoint[]
  totalPoints: number
  trialsDone: number
  consecutiveMisses: number
  rescueFired: number
  fpIsiPresses: number
}

// Mobile keyboard-less devices don't have a Space key, so the
// "press Space" copy in the instructions and pause screens is just
// noise there. Computed once at module load — orientation doesn't
// change whether the device has a hardware keyboard.
const isMobileDevice = isPhoneLikeDevice()

interface Props {
  eye: StoredEye
  calibration: CalibrationData
  extendedField: boolean
  onDone: () => void
  onComplete?: (points: TestPoint[]) => void
  /** Pace selected from the home-screen toggle.
   *
   *  - `'normal'` / `'slow'` — same 24-2 grid (or whatever the user
   *    chose in Advanced Settings); `'slow'` uses longer per-trial
   *    timings and more staircase reversals.
   *  - `'quick'` — scope shrink: forces the 10-2 grid (central ±9°
   *    only) regardless of the Advanced Settings selection. Timing /
   *    reversal count borrow the `'normal'` preset (a quick scan is
   *    about smaller spatial scope, not about racing through each
   *    location). Best for tracking macular involvement; **not**
   *    suitable for RP peripheral-field monitoring — the 10-2's
   *    central 10° is the part RP preserves longest. The Ready
   *    screen surfaces that caveat. */
  speedMode?: RunSpeedMode
}

export function StaticTest({ eye, calibration, onDone, onComplete, speedMode = 'normal' }: Props) {
  const { user, syncResults } = useAuth()
  const canViewReliability = user?.isAdmin === true || user?.isClinician === true
  const { pixelsPerDegree, maxEccentricityDeg } = calibration
  // `presetKey` resolves the SPEED_PRESETS lookup. Quick uses the
  // same per-trial timings + reversal count as Normal; the time
  // savings come from running fewer locations (10-2 instead of 24-2),
  // not from racing through each one.
  const presetKey: 'normal' | 'slow' = speedMode === 'quick' ? 'normal' : speedMode

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
  // Quick scan forces the 10-2 grid (central ±9° only — for macular
  // tracking) regardless of the user's Advanced Settings grid
  // preference. This is the scope-shrink that earns the ~3-4 min
  // duration; without it Quick would be indistinguishable from
  // Normal. Custom grid is dropped in Quick (10-2 is the fixed
  // central-field option). Normal/Slow honour the user's grid
  // selection as before.
  const gridPattern: StaticGridPattern = speedMode === 'quick' ? '10-2' : advanced.staticGridPattern
  const customGrid = speedMode === 'quick' ? undefined : advanced.customGrid
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
        reversalsRequired: SPEED_PRESETS[presetKey].reversalsRequired,
      }
    : SPEED_PRESETS[presetKey]

  // Phone-in-headset (`phone-vr`): the active lens half. `eye` is a single
  // side here; `both` runs are split upstream. The vertical lens-center
  // offset only applies in VR — standard mode keeps fixation on the midline.
  const vr = calibration.vr?.enabled ? calibration.vr : null
  const activeEye: 'left' | 'right' = eye === 'left' ? 'left' : 'right'
  const fixationXY = (() => {
    if (!vr) return { x: calibration.fixationOffsetPx, y: 0 }
    const vp = computeVrViewport(window.innerWidth, window.innerHeight, activeEye, vr)
    return {
      x: Math.round(vp.fixationXFromScreenCenter),
      y: Math.round(vp.fixationYFromScreenCenter),
    }
  })()

  // ---------- grid coverage ----------
  // The HFA grids are defined in visual-angle degrees (±27° for 24-2,
  // ±30° for 30-2, ±10° for 10-2). Each location has to land inside the
  // visible viewport when projected with the same `degToPx` +
  // `fixationOffsetPx` math the renderer uses — otherwise the dot
  // flashes off-screen and the staircase converges to a bogus
  // "not seen" the patient never had a chance to detect.
  //
  // The earlier version filtered by a single scalar
  // `r <= maxEccentricityDeg`, where `maxEccentricityDeg` is the
  // *furthest* edge distance from fixation. That kept points whose
  // actual rendered position fell off the opposite (closer) edge — the
  // problem is acute with fixation shifted 20% toward the nose, which
  // leaves the nasal field covering only ~30% of screen width while
  // the temporal field gets ~70%. A point at (-15°, 9°) clears
  // `r=17.5 ≤ 22°` even though only ~9° of nasal space exists. Result:
  // ~⅓ of 24-2 locations rendered off-screen at typical desktop
  // geometries. Direction-aware projection fixes this.
  //
  // Viewport dimensions are read from `window` (matched by the resize
  // listener below) rather than `calibration.screenWidthPx`, because
  // the renderer positions stimuli relative to the *live* viewport
  // (`top:50% / left:50%`) — not the screen the calibration was
  // captured at. A browser windowed below screen size, or fullscreen
  // entering between calibration and test, would otherwise diverge.
  const [viewportTick, setViewportTick] = useState(0)
  useEffect(() => {
    const onResize = () => setViewportTick(t => t + 1)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  const gridCoverage = useMemo(() => {
    void viewportTick
    const screenW = typeof window !== 'undefined' ? window.innerWidth : 0
    const screenH = typeof window !== 'undefined' ? window.innerHeight : 0
    const fullGrid = getStaticGrid(
      gridPattern,
      eye,
      gridPattern === 'custom' ? customGrid : undefined,
    )
    // In VR, locations must fall inside the active lens half (not the whole
    // screen) so nothing renders in the untested eye's half. Standard mode
    // clamps to the full viewport.
    const vp = vr ? computeVrViewport(screenW, screenH, activeEye, vr) : null
    const minX = vp ? vp.originX : 0
    const maxX = vp ? vp.originX + vp.width : screenW
    const fitting = fullGrid.filter(p => {
      const offsetXPx = degToPx(p.xDeg, calibration)
      const offsetYPx = degToPx(p.yDeg, calibration)
      const absX = screenW / 2 + fixationXY.x + offsetXPx
      const absY = screenH / 2 + fixationXY.y - offsetYPx
      return absX >= minX && absX <= maxX
        && absY >= 0 && absY <= screenH
    })
    return {
      totalLocations: fullGrid.length,
      grid: fitting,
      dropped: fullGrid.length - fitting.length,
    }
  }, [gridPattern, eye, customGrid, calibration, vr, activeEye, fixationXY.x, fixationXY.y, viewportTick])

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
  const [surveyDone, setSurveyDone] = useState(false)
  // Active-prompt feedback modal — fires once per device, on either
  // Done or Export PDF. `'done'` runs handleDone() on close; `'pdf'`
  // closes the modal in place so the user keeps seeing the results.
  const [feedbackTrigger, setFeedbackTrigger] = useState<'done' | 'pdf' | null>(null)

  // ---------- practice (unscored warm-up) ----------
  // First-timers learn "press the instant you see the dot" on big, bright,
  // central dots that don't touch any staircase, instead of fumbling the
  // mechanic during scored trials (the detected:0 / quit-then-retry-44/44
  // abort signature). Skipped once learned on this device.
  const practiceDoneRef = useRef<boolean>(isPracticeDone())
  const practiceSeenRef = useRef(0)
  const practiceStimVisibleRef = useRef(false)
  const [practiceIdx, setPracticeIdx] = useState(0)

  // ---------- resume (cross-reload recovery) ----------
  // A stable fingerprint of the calibration + run config; a snapshot only
  // restores if it still matches, so a recalibration or settings change
  // can't resurrect a now-invalid run.
  const calibrationKey = useMemo(
    () => [
      Math.round(pixelsPerDegree * 100),
      Math.round((calibration.viewingDistanceCm ?? 0) * 10),
      Math.round((calibration.brightnessFloor ?? 0) * 1000),
      Math.round(maxEccentricityDeg ?? 0),
      Math.round(calibration.fixationOffsetPx ?? 0),
      vr ? 'vr' : 'std',
      eye,
    ].join('|'),
    [pixelsPerDegree, calibration, maxEccentricityDeg, vr, eye],
  )
  const resumeKeyStr = useMemo(() => resumeKey('static', eye), [eye])
  const trialsDoneRef = useRef(0)

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

  // Write a resume snapshot from the live refs. Called once per presentation
  // and on teardown, so a reload/discard mid-run can be recovered instead of
  // throwing away 7–8 minutes. No-op outside an active scored run.
  const persistSnapshot = useCallback(() => {
    if (!startedTrackedRef.current || completedTrackedRef.current) return
    if (phaseRef.current !== 'testing' && phaseRef.current !== 'paused') return
    const payload: StaticResumePayload = {
      calibrationKey,
      gridPattern: gridPatternRef.current,
      speedMode,
      startedAt: testStartedAtRef.current,
      grid: gridRef.current,
      queue: queueRef.current,
      staircases: serializeStaircases(staircasesRef.current),
      thresholdResults: thresholdResultsRef.current,
      totalPoints: gridRef.current.length,
      trialsDone: trialsDoneRef.current,
      consecutiveMisses: consecutiveMissesRef.current,
      rescueFired: rescueFiredRef.current,
      fpIsiPresses: fpIsiPressesRef.current,
    }
    saveResumeSnapshot(resumeKeyStr, payload)
  }, [calibrationKey, speedMode, resumeKeyStr])

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
  // The single "advance / I see it" action, shared by the keyboard, screen
  // taps, and the Bluetooth VR remote. Phase-aware: resumes from pause, gates
  // false-positive presses during the inter-stimulus gap, otherwise records a
  // response. (Static has no interstitial phase — countdown runs straight into
  // testing — so there's no interstitial branch here.)
  const handleAdvanceButton = () => {
    if (phaseRef.current === 'paused') {
      resume()
    } else if (phaseRef.current === 'practice') {
      beep()
      handlePracticeResponse()
    } else {
      // Any press during the test gets the perimeter-style confirmation tone,
      // so a patient in a headset hears that the button registered.
      beep()
      if (isiActiveRef.current) {
        fpIsiPressesRef.current += 1
        return
      }
      handleResponse()
    }
  }

  // VR/Bluetooth remote + controller support. Headset clickers and gamepads
  // (e.g. an SC-803's trigger, rocker, A/B/X/Y) reach us via media keys (the
  // confirm button's Play/Pause, claimed through the MediaSession) or the
  // Gamepad API rather than as keydowns; the hook routes any of them to the
  // same advance action and provides the press-confirmation beep. `armRemote`
  // must run inside a user gesture — see enterFullscreen, which fires on the
  // start/resume tap.
  const { arm: armRemote, beep, disarm: disarmRemote } = useRemoteInput(handleAdvanceButton)

  // Release the remote capture once the test is over (results screen) so its
  // button stops owning the phone's media session and swallowing taps like the
  // results-screen "Sign in" button.
  useEffect(() => {
    if (phase === 'results') disarmRemote()
  }, [phase, disarmRemote])

  const enterFullscreen = useCallback(() => {
    // Claim the media session from inside this gesture so the VR remote's
    // button reaches us instead of the user's background music app.
    armRemote()
    try {
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>
      }
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {})
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
    } catch { /* not supported */ }
    if (typeof window !== 'undefined') window.scrollTo(0, 1)
  }, [armRemote])

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
      trialsDoneRef.current += 1
      setTrialsDone(n => n + 1)
      // Checkpoint for cross-reload resume: by now the previous trial's
      // staircase update has been applied, so this captures cumulative state.
      persistSnapshot()
      hideTimeoutRef.current = setTimeout(() => hideStimulus(), sp.stimulusMs)
      responseTimeoutRef.current = setTimeout(() => {
        if (!respondedRef.current && currentStaircaseKeyRef.current === thePoint.key) {
          hideStimulus()
          // No fixation flash on miss. Missing dots is the *normal* state
          // of a static perimetry trial (it's literally how the staircase
          // walks dimmer), and a red flash made every dimming step feel
          // like a failure — demoralising on a self-test, and a fresh
          // peripheral red flicker also pulls saccades away from
          // fixation, which is exactly what we don't want.
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
    recordThresholdPoint,
    countPendingStaircases,
    persistSnapshot,
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
      // complete normally). Neutral cue (not red): a genuine early "I saw
      // it" that lands a hair too soon shouldn't be met with the only
      // alarm colour in the run.
      flashFixation(NEUTRAL_FLASH, 300)
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
      // Checkpoint while phaseRef is still 'testing' so a reload from the
      // pause screen can resume.
      persistSnapshot()
      setPhase('paused')
    }
  }, [clearAllTimeouts, hideStimulus, persistSnapshot])

  const resume = useCallback(() => {
    const resumePhase = pausedPhaseRef.current
    setPhase(resumePhase)
    phaseRef.current = resumePhase
    enterFullscreen()
    setTimeout(() => presentNext(), 1000)
  }, [presentNext, enterFullscreen])

  // ---------- practice (unscored warm-up) ----------
  const finishPractice = useCallback(() => {
    clearAllTimeouts()
    hideStimulus()
    practiceStimVisibleRef.current = false
    if (!practiceDoneRef.current) {
      markPracticeDone()
      practiceDoneRef.current = true
    }
    setPhase('countdown')
    phaseRef.current = 'countdown'
    setCountdown(3)
  }, [clearAllTimeouts, hideStimulus])

  const presentPractice = useCallback(() => {
    if (phaseRef.current !== 'practice') return
    const pos = PRACTICE_POSITIONS[practiceSeenRef.current % PRACTICE_POSITIONS.length]
    clearAllTimeouts()
    practiceStimVisibleRef.current = false
    delayTimeoutRef.current = setTimeout(() => {
      if (phaseRef.current !== 'practice') return
      showStimulus(pos.xDeg, pos.yDeg, STIMULI['V4e'].sizeDeg, 1)
      practiceStimVisibleRef.current = true
      hideTimeoutRef.current = setTimeout(() => hideStimulus(), 900)
      responseTimeoutRef.current = setTimeout(() => {
        if (phaseRef.current !== 'practice') return
        // Missed in practice — no penalty, just show it again.
        practiceStimVisibleRef.current = false
        hideStimulus()
        delayTimeoutRef.current = setTimeout(() => presentPractice(), 600)
      }, 1600)
    }, 600)
    // self-reference is intentional; the recursive call uses the closure var.
  }, [clearAllTimeouts, showStimulus, hideStimulus])

  const handlePracticeResponse = useCallback(() => {
    if (phaseRef.current !== 'practice') return
    if (!practiceStimVisibleRef.current) return // press in the gap — ignore
    practiceStimVisibleRef.current = false
    clearAllTimeouts()
    hideStimulus()
    flashFixation('#22c55e', 200)
    practiceSeenRef.current += 1
    setPracticeIdx(practiceSeenRef.current)
    if (practiceSeenRef.current >= PRACTICE_TRIALS) {
      responseTimeoutRef.current = setTimeout(() => finishPractice(), 500)
    } else {
      responseTimeoutRef.current = setTimeout(() => presentPractice(), 700)
    }
  }, [clearAllTimeouts, hideStimulus, flashFixation, presentPractice, finishPractice])

  // Setup gate: after instructions (and the optional position check), run the
  // one-time practice warm-up, otherwise go straight to the countdown.
  const beginAfterChecks = useCallback(() => {
    if (!practiceDoneRef.current) {
      practiceSeenRef.current = 0
      setPracticeIdx(0)
      setPhase('practice')
      phaseRef.current = 'practice'
      presentPractice()
    } else {
      setPhase('countdown')
      setCountdown(3)
    }
  }, [presentPractice])

  // ---------- keyboard + pointer ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (phaseRef.current === 'testing') pauseTest()
        else if (phaseRef.current === 'paused') resume()
        return
      }
      if (e.key === ' ' || e.key === 'Enter' || REMOTE_RESPONSE_KEYS.has(e.key)) {
        e.preventDefault()
        handleAdvanceButton()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // handleAdvanceButton is a fresh closure each render but only reads refs +
  // the listed callbacks, so re-subscribing on those is sufficient.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleResponse, resume, pauseTest])

  const handlePointerDown = useCallback(() => {
    beep()
    if (isiActiveRef.current) {
      fpIsiPressesRef.current += 1
      return
    }
    handleResponse()
  }, [handleResponse, beep])

  // ---------- start test ----------
  const startTest = useCallback(() => {
    enterFullscreen()
    // Cold start of a fresh run — discard any stale resume snapshot for this
    // eye so a later reload doesn't offer to resume the abandoned attempt.
    clearResumeSnapshot(resumeKeyStr)
    staircasesRef.current.clear()
    thresholdResultsRef.current = []
    consecutiveMissesRef.current = 0
    rescueTrialRef.current = false
    rescueFiredRef.current = 0
    fpIsiPressesRef.current = 0
    isiActiveRef.current = false
    trialsDoneRef.current = 0
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
      beginAfterChecks()
    }
  }, [enterFullscreen, gridCoverage, sp.reversalsRequired, advanced.initialBlindspotCheck, beginAfterChecks, resumeKeyStr])

  const handlePositionCheckPass = useCallback(() => {
    beginAfterChecks()
  }, [beginAfterChecks])

  // ---------- restart ----------
  // "Restart from the beginning" out of the pause menu. Crucially this
  // must NOT trip the abort path: the user *chose* to start over (often
  // because the early presentations felt frustrating), they didn't
  // abandon the test. Resetting `startedTrackedRef` before calling
  // `startTest` keeps the unmount/pagehide guard
  // (`started && !completed && !abortDispatched`) inert for the
  // discarded attempt; the new attempt re-fires `test_started` on its
  // own countdown→testing transition, so telemetry tracks the fresh
  // run from its actual start time. `startTest` itself re-initialises
  // staircases, queue, results, counters and rescue/FP state, so the
  // restarted run is indistinguishable from a cold launch.
  const handleRestart = useCallback(() => {
    clearAllTimeouts()
    startedTrackedRef.current = false
    testStartedAtRef.current = null
    startTest()
  }, [clearAllTimeouts, startTest])

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

  // `abortVia` distinguishes the three teardown sources so the abort metric
  // can be read honestly: `user_quit` is a deliberate quit from the pause
  // menu (real abandonment), `pagehide` is a page teardown (close / hard
  // nav — bfcache is already filtered out before we get here), `unmount` is
  // in-SPA navigation. `leave` enriches pagehide aborts with the bfcache /
  // visibility / nav classification so benign teardown can be excluded
  // downstream.
  const buildAbortMeta = useCallback((
    via: 'unmount' | 'pagehide' | 'user_quit',
    leave?: PageLeaveInfo,
  ): Record<string, string> => {
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
      ...(leave ? pageLeaveMeta(leave) : {}),
      ...getDeviceInfo(),
      ...buildStudyEventMeta(studyMode),
      ...summaryMeta,
      ...(durationSeconds != null ? { durationSeconds: String(durationSeconds) } : {}),
    }
  }, [eye, getTestDurationSeconds, speedMode, studyMode])

  // All accidental-teardown guards, centralised so Static and Goldmann
  // behave identically (see testLifecycle):
  //  - pagehide → abort beacon, but bfcache backgrounding is skipped so a
  //    tab-switch / mobile app-switch that later returns isn't mis-counted;
  //  - tab hidden or fullscreen exited mid-presentation → clean auto-pause
  //    (so the reflexive Esc that the browser eats to leave fullscreen lands
  //    the user on the pause screen instead of a still-running broken test);
  //  - beforeunload → confirm before a reflexive Cmd+R nukes the run.
  useActiveTestGuards({
    isRunActive: () =>
      startedTrackedRef.current && !completedTrackedRef.current && !abortDispatchedRef.current,
    isPresenting: () => phaseRef.current === 'testing' || phaseRef.current === 'practice',
    onTeardown: (info) => {
      if (abortDispatchedRef.current) return
      if (!startedTrackedRef.current || completedTrackedRef.current) return
      // Capture the very latest state for resume before the page goes.
      persistSnapshot()
      abortDispatchedRef.current = true
      trackEventBeacon('test_aborted', getDeviceId(), buildAbortMeta('pagehide', info))
    },
    onAutoPause: () => pauseTest(),
  })

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
      // Run finished — the resume snapshot is no longer needed.
      clearResumeSnapshot(resumeKeyStr)
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
  }, [phase, eye, results, getTestDurationSeconds, speedMode, studyMode, resumeKeyStr])

  const handleDone = () => {
    exitFullscreen()
    onDone()
  }

  // Deliberate quit from the pause menu. Unlike an in-SPA unmount this is a
  // clear "I give up", so it's logged with abortVia:'user_quit' — the real
  // abandonment signal, distinct from React teardown. Setting the dedupe
  // flag first keeps the unmount cleanup from firing a second abort.
  const handleQuit = () => {
    if (
      startedTrackedRef.current
      && !completedTrackedRef.current
      && !abortDispatchedRef.current
    ) {
      abortDispatchedRef.current = true
      trackEvent('test_aborted', getDeviceId(), buildAbortMeta('user_quit')).catch(() => {})
    }
    clearResumeSnapshot(resumeKeyStr)
    handleDone()
  }

  // ---------- resume (cross-reload recovery) ----------
  const [resumeOffer, setResumeOffer] = useState<StaticResumePayload | null>(null)

  // Detect a fresh, matching snapshot on mount and offer to resume.
  useEffect(() => {
    const snap = loadResumeSnapshot<StaticResumePayload>(resumeKeyStr)
    if (
      snap
      && snap.calibrationKey === calibrationKey
      && snap.gridPattern === gridPatternRef.current
      && snap.speedMode === speedMode
      && Array.isArray(snap.staircases)
      && snap.staircases.some(([, s]) => !s.done)
    ) {
      setResumeOffer(snap)
    }
    // Mount-only check — the relevant inputs are fixed for a given mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resumeFromSnapshot = useCallback((snap: StaticResumePayload) => {
    enterFullscreen()
    gridRef.current = snap.grid
    queueRef.current = snap.queue
    staircasesRef.current = deserializeStaircases(snap.staircases)
    thresholdResultsRef.current = snap.thresholdResults
    consecutiveMissesRef.current = snap.consecutiveMisses
    rescueFiredRef.current = snap.rescueFired
    fpIsiPressesRef.current = snap.fpIsiPresses
    rescueTrialRef.current = false
    isiActiveRef.current = false
    trialsDoneRef.current = snap.trialsDone
    setTrialsDone(snap.trialsDone)
    setTotalPoints(snap.totalPoints || snap.grid.length)
    setRemainingCount(countPendingStaircases())
    // Continuation, not a new run: keep the original start time and do NOT
    // re-fire test_started (the countdown effect is gated on this ref).
    testStartedAtRef.current = snap.startedAt ?? Date.now()
    startedTrackedRef.current = true
    completedTrackedRef.current = false
    abortDispatchedRef.current = false
    setResumeOffer(null)
    // Re-centre the patient with a fresh countdown before resuming stimuli.
    setPhase('countdown')
    setCountdown(3)
  }, [enterFullscreen, countPendingStaircases])

  const declineResume = useCallback(() => {
    clearResumeSnapshot(resumeKeyStr)
    setResumeOffer(null)
  }, [resumeKeyStr])

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
    exportTrackedResultPDF(result, { includeReliabilityDetails: canViewReliability })
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
    // every location where the staircase converged. We still run them
    // through calcIsopterAreas so a III4e seen-points area lands in
    // the saved record — the III4e-over-time chart on the History
    // page uses it, and the (Goldmann-only) clinical scenario
    // comparison reads from this field too. The scenario comparison
    // itself is no longer shown on the static results page because
    // the static seen-points hull and the kinetic isopter boundary
    // are different things and can't be apples-to-apples compared.
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
        ...(vr ? { presentationMode: 'phone-vr' as const, vrHeadsetPreset: vr.headsetPreset } : {}),
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
  }

  // If the user signs in after finishing the test (via SavePrompt on the
  // results screen), retry persistence so the just-completed run lands
  // on their new account. saveResult is idempotent by id.
  useEffect(() => {
    if (!user || !lastResultRef.current) return
    saveResult(lastResultRef.current)
    syncResults()
  }, [user, syncResults])

  // ==================== RENDER ====================

  // Resume offer takes precedence over the instructions screen: a returning
  // reload should recover the in-progress run, not silently restart it.
  if (resumeOffer && phase === 'instructions') {
    const done = resumeOffer.thresholdResults.length
    const total = resumeOffer.totalPoints || resumeOffer.grid.length
    return (
      <div className={`min-h-screen ${bgClass} text-white flex items-center justify-center p-6`}>
        <main className="max-w-md w-full space-y-6 text-center">
          <h1 className="text-2xl font-semibold">Resume your test?</h1>
          <p className="text-gray-300">
            We found an unfinished {eye === 'right' ? 'right' : 'left'} eye test on this device
            — you'd measured <strong>{done}</strong> of {total} points. Pick up where you
            left off, or start fresh.
          </p>
          <div className="space-y-3 pt-2">
            <button
              onClick={() => resumeFromSnapshot(resumeOffer)}
              className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
            >
              Resume test
            </button>
            <button
              onClick={declineResume}
              className="w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
            >
              Start fresh
            </button>
          </div>
        </main>
      </div>
    )
  }

  if (phase === 'practice') {
    const remaining = Math.max(0, PRACTICE_TRIALS - practiceIdx)
    return (
      <div
        className={`h-[100dvh] ${bgClass} text-white select-none cursor-none relative overflow-hidden`}
        role="application"
        aria-label="Practice round. Press Space or tap when you see a dot."
        onPointerDown={() => { beep(); handlePracticeResponse() }}
      >
        {/* Practice copy lives top-and-bottom, away from the central dots, so
            it teaches the mechanic without sitting where stimuli appear. */}
        <div className="absolute inset-x-0 top-0 pt-[max(1rem,env(safe-area-inset-top))] text-center px-6">
          <p className="text-sm text-gray-300">
            Practice — no score yet. {isMobileDevice ? 'Tap' : 'Press Space or tap'} the moment you see a dot.
          </p>
          <p className="text-xs text-gray-500 mt-1">{remaining} to go</p>
        </div>

        {/* Fixation dot (same ref the flash writes to). */}
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

        {/* Practice stimulus (same ref showStimulus writes to). */}
        <div
          ref={stimulusRef}
          className="absolute rounded-full bg-white"
          style={{ top: '50%', left: '50%', width: 6, height: 6, opacity: 0, willChange: 'transform', zIndex: 5 }}
        />

        <div className="absolute inset-x-0 bottom-0 pb-[max(1rem,env(safe-area-inset-bottom))] text-center px-6">
          <button
            onClick={(e) => { e.stopPropagation(); finishPractice() }}
            className="text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2"
          >
            Skip practice
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'instructions') {
    return (
      <div className={`min-h-screen ${bgClass} text-white flex items-center justify-center p-6`}>
        <main className="max-w-md space-y-6 text-center">
          <h1 className="text-2xl font-semibold">
            {eye === 'right' ? 'Right' : 'Left'} eye — static test
          </h1>

          {!vr && (
            <HeadGuide
              eye={eye}
              viewingDistanceCm={calibration.viewingDistanceCm}
              mode={isMobileDevice ? 'phone' : 'desktop'}
            />
          )}

          <div className="text-left space-y-3 text-gray-300">
            <p>
              1. {vr
                ? <>Seat the phone in the headset and <strong>put the headset on</strong></>
                : <>Cover your <strong>{eye === 'right' ? 'left' : 'right'} eye</strong></>}
            </p>
            <p>2. Stare at the <span className="text-yellow-400">yellow dot</span> — don't look away</p>
            <p>3. Dots will <strong>flash briefly</strong> at known test positions</p>
            <p>
              4. {isMobileDevice ? <><strong>Tap</strong> the screen when you see a dot</> : <>Press <kbd className="px-2 py-0.5 bg-gray-800 rounded text-sm">Space</kbd> or <strong>tap</strong> when you see a dot</>}
            </p>
            <p>5. It's <em>normal</em> to miss many flashes — that's how the test finds your threshold</p>
          </div>

          <p className="text-xs text-gray-500">
            {isMobileDevice ? (
              <>Tap the <span className="text-yellow-400">yellow dot</span> any time to pause the test or exit.</>
            ) : (
              <>Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-[10px] font-mono text-gray-300">Esc</kbd> any time to pause the test or exit.</>
            )}
          </p>

          <p className="text-xs text-gray-500">
            Self-monitoring tool, not a clinical diagnosis. Always consult your ophthalmologist.
          </p>

          {gridCoverage.dropped > 0 && (
            <div
              role="alert"
              className="text-left text-sm bg-amber-900/30 border border-amber-600/50 rounded-lg px-4 py-3 text-amber-200"
            >
              <strong className="block mb-1">Grid not fully covered</strong>
              {gridCoverage.dropped} of {gridCoverage.totalLocations} locations in the{' '}
              {gridPattern === 'custom' ? 'custom' : `HFA ${gridPattern}`} pattern fall outside your
              {vr ? ' active lens half' : ' screen'} at this viewing distance and will be skipped.{' '}
              {vr
                ? 'A smaller grid (e.g. 10-2) fits the lens half better.'
                : 'Sit closer to the screen (and recalibrate) to cover more of the pattern.'}
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
        className={`h-[100dvh] ${bgClass} text-white select-none cursor-none relative overflow-hidden`}
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
        {vr && (
          <VrTestSurface
            viewport={computeVrViewport(window.innerWidth, window.innerHeight, activeEye, vr)}
            innerWidth={window.innerWidth}
            showDivider
          />
        )}
      </div>
    )
  }

  if (phase === 'paused') {
    // Completed so far = number of staircases that already have a
    // recorded threshold. Stop-and-view-results lands the user on the
    // results phase even with zero converged points; the results render
    // shows an empty-state instead of silently bouncing them home.
    const done = thresholdResultsRef.current.length
    const progressPct = totalPoints > 0 ? (done / totalPoints) * 100 : 0
    return (
      <PauseScreen
        bgClass={bgClass}
        progressText={`${done} / ${totalPoints} points measured`}
        progressPct={progressPct}
        onResume={resume}
        onRestart={handleRestart}
        onStop={() => {
          setResults([...thresholdResultsRef.current])
          setPhase('results')
        }}
        onQuit={handleQuit}
      />
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
        <div className={`min-h-screen bg-base text-body p-6 overflow-y-auto`}>
          <main className="max-w-lg mx-auto space-y-6 pb-12 text-center">
            <h1 className="text-2xl font-semibold">Results</h1>
            <p className="text-sm text-muted">
              {gridPattern === 'custom' ? 'Custom' : `HFA ${gridPattern}`} · {formatEyeLabel(eye)}
            </p>
            <div className="rounded-lg border border-line bg-surface p-4 text-sm text-body space-y-2 text-left">
              <p className="font-medium text-ink">No measurements yet</p>
              <p className="text-muted leading-relaxed">
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
      <div className={`min-h-screen bg-base text-body p-6 overflow-y-auto`}>
        <main className="max-w-lg mx-auto space-y-6 pb-12">
          {savedId && <SavePrompt />}
          {/* HFA-style result page — threshold map, greyscale plot,
              and summary indices laid out the same way a Humphrey
              Single Field Analysis prints them. Replaces the prior
              ad-hoc heatmap-plus-scenario layout. */}
          <HFAResultsView
            points={results}
            eye={eye}
            gridPattern={gridPattern}
            date={lastResultRef.current?.date}
            durationSeconds={getTestDurationSeconds()}
            brightnessFloor={calibration.brightnessFloor}
            maxEccentricityDeg={maxEccentricityDeg}
            fpIsiPresses={fpIsiPressesRef.current}
            truePositiveResponses={results.length}
            showReliability={canViewReliability}
          />
          {gridCoverage.dropped > 0 && (
            <p className="text-center text-xs text-amber-700">
              Partial grid coverage: {gridCoverage.grid.length} of {gridCoverage.totalLocations} locations
              presented. Outer points fell outside your screen at this viewing distance.
            </p>
          )}
          <ClinicalDisclaimer variant="results" />
          {/* Prior content here was the RP scenario comparison and a
              "Vision simulation" expander. Both have been removed —
              see commits e7fefa7 (scenario picker) and b8ec08f
              (vision simulator) for the rationale. */}
          {surveyDone && (
            <p className="text-center text-green-600 text-xs">Thank you for your feedback!</p>
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
              className="flex-1 py-3 bg-white border border-line hover:bg-slate-50 text-body rounded-lg font-medium transition-colors"
            >
              Done
            </button>
          </div>
        </main>

        {feedbackTrigger && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
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
  // First-minute confidence: a thin top-edge bar (far from the central
  // fixation zone) that advances from the very first trial, plus a brief
  // "working" line, so a dark, near-silent screen doesn't read as frozen
  // and get tab-closed in the first ~40s (the early-abort signature).
  const barExpectedTrialsPerPoint = sp.reversalsRequired + 2
  const barProgress = totalPoints > 0
    ? Math.min(1, trialsDone / Math.max(1, totalPoints * barExpectedTrialsPerPoint))
    : 0
  const showWorkingHint = trialsDone < 8
  return (
    <div
      className={`h-[100dvh] ${bgClass} select-none cursor-none relative overflow-hidden`}
      role="application"
      aria-label={`Visual field test in progress for ${eye} eye. Press Space or tap when you see a dot.`}
      onPointerDown={handlePointerDown}
    >
      {/* Top-edge progress + reassurance — non-VR only (VR has no spare
          screen edge and its own surface treatment). */}
      {!vr && (
        <div className="absolute inset-x-0 top-0" style={{ zIndex: 8 }} aria-hidden="true">
          <div className="h-1 w-full bg-white/10">
            <div
              className="h-full bg-teal transition-all duration-300"
              style={{ width: `${Math.round(barProgress * 100)}%` }}
            />
          </div>
          {showWorkingHint && (
            <p className="text-center text-[11px] text-gray-500 mt-1">
              Working — first results appear shortly
            </p>
          )}
        </div>
      )}
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

      {/* Mobile pause hit-target — keyboardless devices have no Esc, and a
          persistent pause button anywhere on screen would pull the eye away
          from fixation (the very thing we need it to do *not*). The fovea
          is the one place the user is already looking, so a tap on the
          fixation dot is the natural pause trigger. 44×44 matches the iOS
          minimum tappable size; smaller targets force the user to look down
          at their finger to aim, which defeats the point. stopPropagation
          stops the outer "saw a stimulus" handler from also firing.
          Static 24-2's innermost points sit at r≈4°, well outside this
          ~½° hit zone at typical viewing distances, so it doesn't intercept
          real responses. */}
      {isMobileDevice && (
        <div
          role="button"
          aria-label="Pause test"
          className="absolute"
          style={{
            top: '50%',
            left: '50%',
            width: 44,
            height: 44,
            marginLeft: -22 + fixationXY.x,
            marginTop: -22 + fixationXY.y,
            zIndex: 11,
          }}
          onPointerDown={e => {
            e.stopPropagation()
            pauseTest()
          }}
        />
      )}

      {/* Active stimulus */}
      <div
        ref={stimulusRef}
        className="absolute rounded-full bg-white"
        style={{ top: '50%', left: '50%', width: 6, height: 6, opacity: 0, willChange: 'transform', zIndex: 5 }}
      />

      {/* Inactive-lens mask — divider hidden during measurement. */}
      {vr && (
        <VrTestSurface
          viewport={computeVrViewport(window.innerWidth, window.innerHeight, activeEye, vr)}
          innerWidth={window.innerWidth}
          showDivider={false}
        />
      )}
    </div>
  )
}
