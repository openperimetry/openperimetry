import { useState, useEffect, useRef, useCallback } from 'react'

// Picks the dimensions the test will actually run in.
//
// Desktop: the test enters real fullscreen, so the testable canvas is
// `screen.width × screen.height` regardless of current window size.
//
// Mobile: iPhone Safari can't enter true fullscreen on arbitrary
// elements (see GoldmannTest comments), so the test runs inside the
// current viewport — `window.innerWidth × innerHeight`. Just as
// importantly, `screen.width/height` on iOS Safari does NOT swap on
// orientation change, so reading from `screen.*` here would freeze the
// field-coverage diagram in the initial orientation no matter how many
// `orientationchange` events we listened for. The viewport swaps
// reliably; the screen object does not.
function effectiveTestDims(isMobile: boolean): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1440, height: 900 }
  if (isMobile) return { width: window.innerWidth, height: window.innerHeight }
  return {
    width: typeof screen !== 'undefined' ? screen.width : window.innerWidth,
    height: typeof screen !== 'undefined' ? screen.height : window.innerHeight,
  }
}
import type { CalibrationData, Eye, PresentationMode, RunSpeedMode, VrHeadsetPreset } from '../types'
import {
  VR_HEADSET_SPECS,
  clampLensSeparationPx,
  vrDefaultLensSeparationFraction,
  vrMaxFieldHalfDeg,
  vrPixelsPerDegree,
} from '../vrCalibration'
import { computeVrViewport, vrMaxEccentricityDeg } from '../vrGeometry'
import { VrTestSurface } from './VrTestSurface'
import { useRemoteInput, useCountdownAdvance } from '../remoteInput'
import { BackButton } from './AccessibleNav'
import { CALIBRATION } from '../constants'
import { formatEyeLabelLong } from '../eyeLabels'
import { AdvancedSettingsPanel } from './AdvancedSettingsPanel'
import { useAdvancedSettings } from '../advancedSettings'
import { STATIC_GRID_INFO, countCustomGridPoints } from '../grids'
import type { StaticGridPattern } from '../grids'
import { useStudyMode } from '../studyMode'
import { isPhoneLikeDevice } from '../deviceMode'
import { trackEvent } from '../api'
import { getDeviceId } from '../storage'
import {
  addScreen,
  clearActiveScreen,
  getActiveScreen,
  updateScreen,
} from '../screenCalibration'

const CREDIT_CARD_WIDTH_MM = 85.6
const CREDIT_CARD_HEIGHT_MM = 53.98
const RT_TRIALS = 5

// In-headset timer-fallback durations (seconds). Once the phone is in the
// headset the patient can't reach the screen, so each confirm step also
// auto-advances if no remote press arrives. Ready intentionally starts fast:
// once the phone is settled, we do not rely on flaky media/volume controls.
const VR_LENS_GUIDE_AUTO_SECONDS = 12

interface Props {
  eye: Eye
  onCalibrated: (cal: CalibrationData, extendedField: boolean) => void
  onBack: () => void
  /** Skip reaction time calibration (e.g. for static test where user controls pacing) */
  skipReactionTime?: boolean
  /** Test mode label for the summary screen */
  testMode?: 'goldmann' | 'static'
  /** Pace selection from the home screen. Drives the Ready-screen
   *  Goldmann summary (quick mode is a single-isopter scope shrink,
   *  not just a pacing change, so the stimulus + adaptive lines need
   *  to reflect that or the user will think we're running the whole
   *  battery). Defaults to `normal`. Static ignores this; its
   *  Ready-screen copy is the same regardless of pace. */
  speedMode?: RunSpeedMode
  /** Presentation mode from the home screen. `phone-vr` inserts a lens
   *  setup step and emits VR lens geometry in the calibration output.
   *  Defaults to `standard`. */
  presentationMode?: PresentationMode
}

type Step = 'screen' | 'distance' | 'brightness' | 'reaction' | 'vr' | 'ready'

function StepProgress({ current, total }: { current: number; total: number }) {
  const pct = Math.round((current / total) * 100)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>Step {current} of {total}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1 bg-elevated rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-accent to-accent-light rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function CalibrationScreen({ eye, onCalibrated, onBack, skipReactionTime, testMode, speedMode = 'normal', presentationMode = 'standard' }: Props) {
  const isVr = presentationMode === 'phone-vr'
  // Pull the live static-grid pattern and custom-grid params so the
  // "Ready to test" summary can show the exact grid (and point count)
  // the user will run, rather than claiming a generic "54 points".
  const advanced = useAdvancedSettings()
  const studyMode = useStudyMode()
  const studyLocked = studyMode.enabled && studyMode.profile != null
  // Reaction-time calibration is opt-in via advanced settings — without
  // it we use CALIBRATION.DEFAULT_REACTION_TIME_MS so the calibration
  // flow doesn't make every user sit through 5 RT trials by default.
  // Static tests skip it unconditionally (they don't reaction-correct
  // positions) which is what skipReactionTime already encodes.
  const wantsReactionTime = !skipReactionTime && advanced.measureReactionTime

  // Phones have screens so small that the 20 cm floor still leaves the
  // narrowest meridian under ~10°. Allow holding the device closer
  // (down to 10 cm) so handheld users can at least probe the central
  // field. Desktop/tablet keep the 20 cm floor — moving a laptop that
  // close is rarely intentional and usually a slider misclick.
  //
  // The slider min is separate from the *default* floor: even on phones
  // we default to ≥20 cm because closer than that the screen sits inside
  // most adults' near point of accommodation, defocus-blurring every
  // stimulus into a starburst. Users who specifically want more field
  // coverage can still drag the slider down to 10.
  const isMobile = isPhoneLikeDevice()
  const minDistanceCm = isMobile ? 10 : 20
  const defaultMinDistanceCm = 20

  const [savedScreenCal, setSavedScreenCal] = useState(() => getActiveScreen())
  // Skip whichever calibration steps already have a clinic-saved value.
  // Order is screen → distance → brightness → (reaction) → ready, so we
  // jump to the first un-saved step.
  const initialStepBase: Step = !savedScreenCal
    ? 'screen'
    : savedScreenCal.viewingDistanceCm == null
      ? 'distance'
      : savedScreenCal.brightnessFloor == null
        ? 'brightness'
        : !wantsReactionTime
          ? 'ready'
          : 'reaction'
  // VR skips only the arm's-length distance step. Brightness is calibrated
  // before headset insertion with the normal on-screen slider; once the phone
  // goes into the headset there are no volume/button adjustment steps.
  const initialStep: Step = isVr
    ? !savedScreenCal
      ? 'screen'
      : savedScreenCal.brightnessFloor == null
        ? 'brightness'
        : wantsReactionTime
          ? 'reaction'
          : 'vr'
    : initialStepBase
  const [step, setStep] = useState<Step>(initialStep)
  // screen (card) + distance + brightness + (reaction?) + ready.
  // Blindspot position verification happens in the test component itself
  // (as the `position-check` phase) right before the countdown fires, so
  // the patient doesn't have to re-settle between "confirm distance" and
  // "sit for the test". See components/PositionCheckOverlay.tsx.
  // Step order. Phone-VR calibrates screen brightness while the phone is still
  // in hand, then uses known headset optics for the lens geometry. There is no
  // in-headset volume-up / volume-down calibration. Reaction time stays before
  // the headset since it is tap/Space based.
  const stepOrder: Step[] = isVr
    ? ['screen', 'brightness', ...(wantsReactionTime ? (['reaction'] as Step[]) : []), 'vr']
    : ['screen', 'distance', 'brightness', ...(wantsReactionTime ? (['reaction'] as Step[]) : []), 'ready']
  const totalSteps = stepOrder.length
  const stepNumber = Math.max(1, stepOrder.indexOf(step) + 1)

  // Calibration-funnel instrumentation. `test_started` only fires once the
  // user reaches the countdown→testing transition, so everyone who abandons
  // during this wizard is invisible to the abort metric — likely the largest
  // real drop-off and, until now, completely dark. We emit a lightweight
  // page_view per step (already an allow-listed event, so no backend change)
  // so the setup funnel can finally be measured: count step entries vs.
  // test_started to see where first-timers fall out.
  useEffect(() => {
    trackEvent('page_view', getDeviceId(), {
      view: 'calibration',
      calibrationStep: step,
      calibrationStepNumber: String(stepNumber),
      calibrationTotalSteps: String(totalSteps),
      ...(testMode ? { testType: testMode } : {}),
      eye,
    }).catch(() => {})
    // Fire once per distinct step entry.
  }, [step, stepNumber, totalSteps, testMode, eye])

  // Screen calibration — pre-fill from the active clinic-saved workstation
  // if one exists for this display, so a workstation that's already been
  // calibrated doesn't have to redo it before every test.
  const [cardWidthPx, setCardWidthPx] = useState(() => savedScreenCal?.cardWidthPx ?? 320)
  // Default viewing distance derived from screen width AND height + initial
  // card calibration so the narrowest useful meridian (temporal + vertical)
  // subtends ~40° from fixation. Users can still override with the +/−
  // buttons or the "use suggested" link below; this just picks a good
  // starting value instead of the old hardcoded 50 cm which was wrong for
  // small laptops and short for 27" monitors.
  //
  // Why both dimensions: on 16:9 screens, halfHeight is only ~0.56·halfWidth,
  // so a distance chosen from width alone leaves the vertical field at
  // ~25°, which trips the III4e coverage heads-up on the user's screen even
  // at the "suggested" distance. Extended mode is not considered here because
  // extendedField starts false; once the user toggles it the suggestion in
  // the UI recomputes and updates live.
  const [distanceCm, setDistanceCm] = useState<number>(() => {
    if (savedScreenCal?.viewingDistanceCm != null) return savedScreenCal.viewingDistanceCm
    const defaultPxPerMm = 320 / CREDIT_CARD_WIDTH_MM
    const { width: screenWidthPx, height: screenHeightPx } = effectiveTestDims(isMobile)
    const screenWidthCm = screenWidthPx / defaultPxPerMm / 10
    const screenHeightCm = screenHeightPx / defaultPxPerMm / 10
    const targetAngleDeg = 40
    const tan = Math.tan((targetAngleDeg * Math.PI) / 180)
    // Fixation is shifted 20% toward nose → temporal side = 70% of fullWidth.
    // Vertical is halfHeight in normal (non-extended) mode.
    const temporalCm = screenWidthCm * 0.7
    const verticalCm = screenHeightCm * 0.5
    const raw = Math.min(temporalCm, verticalCm) / tan
    return Math.max(defaultMinDistanceCm, Math.min(100, Math.round(raw / 5) * 5))
  })

  // Brightness calibration
  const [brightness, setBrightness] = useState(() => savedScreenCal?.brightnessFloor ?? 0.5)
  const [brightnessFloor, setBrightnessFloor] = useState(() => savedScreenCal?.brightnessFloor ?? 0.04)

  // Extended field — default on for phones, where the screen barely
  // covers the central 30° even in landscape; the two shifted-fixation
  // passes nearly double the vertical reach for ~2 min of extra runtime.
  // Desktops already have plenty of vertical room so the default stays
  // off there. Study profile (handled below) overrides this if locked.
  const [extendedField, setExtendedField] = useState(isMobile)

  // ── Phone VR lens setup ──
  // Lens separation is computed from the headset preset IPD (mm) and the
  // screen's px/mm from the bank-card calibration. That gives a deterministic
  // optical-center offset without asking the user to nudge sliders in-headset.
  const vrPreset: VrHeadsetPreset = 'standard'
  const [vrLensGuideActive, setVrLensGuideActive] = useState(false)

  // Re-render the field-coverage diagram when the viewport rotates or
  // resizes. The diagram reads window/screen dimensions directly in
  // render to project the testable polygon, so without this listener a
  // phone flipped portrait→landscape would keep showing the portrait
  // field shape until something else triggered a re-render.
  const [, setViewportTick] = useState(0)
  useEffect(() => {
    const onResize = () => setViewportTick(t => t + 1)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  // Reaction time calibration
  const [rtStarted, setRtStarted] = useState(false)
  const [rtPhase, setRtPhase] = useState<'waiting' | 'showing' | 'done'>('waiting')
  const [rtTimes, setRtTimes] = useState<number[]>([])
  const [rtCurrent, setRtCurrent] = useState(0)
  const rtStartRef = useRef(0)
  const rtTimeoutRef = useRef(0)
  // Latest `remote.arm`, wired below once the remote hook exists. Held in a ref
  // so the step handlers (defined above the hook) can arm the controller from
  // the tap that enters the headset flow — a real user gesture, while the phone
  // is still in hand — which the gamepad/media transports require.
  const armRef = useRef<() => void>(() => {})

  const cardHeightPx = cardWidthPx * (CREDIT_CARD_HEIGHT_MM / CREDIT_CARD_WIDTH_MM)
  const pxPerMm = cardWidthPx / CREDIT_CARD_WIDTH_MM
  // In phone-VR the screen sits at the lens focal plane, so the angular
  // scale comes from the optics (the headset's known focal length), not a
  // physical viewing distance — the distance step is skipped in VR and
  // `distanceCm` would be meaningless here. Standard mode keeps the
  // arm's-length model.
  const pxPerDeg = isVr
    ? vrPixelsPerDegree(pxPerMm, VR_HEADSET_SPECS[vrPreset].focalLengthMm)
    : pxPerMm * (distanceCm * 10) * Math.tan(Math.PI / 180)
  const vrLensSeparationPx = useCallback((viewportWidthPx: number) => {
    const fraction = vrDefaultLensSeparationFraction(vrPreset, pxPerMm, viewportWidthPx)
    return clampLensSeparationPx(fraction * viewportWidthPx, viewportWidthPx)
  }, [pxPerMm, vrPreset])

  // Shift fixation toward the nose side so the temporal field (larger in RP) gets more screen.
  const fixationOffsetPx = eye === 'right'
    ? -Math.round(window.innerWidth * 0.2)
    : Math.round(window.innerWidth * 0.2)

  // maxEcc is the MAXIMUM distance from fixation to any screen edge.
  // Dots start at the screen edge for each meridian (computed per-direction in GoldmannTest),
  // so we use the largest reachable eccentricity to avoid artificially constraining the test.
  const fixationScreenX = window.innerWidth / 2 + fixationOffsetPx
  const distToLeft = fixationScreenX
  const distToRight = window.innerWidth - fixationScreenX
  const distToTop = window.innerHeight / 2
  const distToBottom = window.innerHeight / 2
  const maxEcc = Math.max(distToLeft, distToRight, distToTop, distToBottom) / pxPerDeg

  const medianRt = rtTimes.length > 0
    ? [...rtTimes].sort((a, b) => a - b)[Math.floor(rtTimes.length / 2)]
    : CALIBRATION.DEFAULT_REACTION_TIME_MS

  const startReactionStep = () => {
    setStep('reaction')
    setRtStarted(false)
    setRtTimes([])
    setRtCurrent(0)
    setRtPhase('waiting')
  }
  const handleScreenDone = () => {
    // Persist the freshly-confirmed card size so subsequent tests on
    // this workstation can skip the screen step entirely. If no
    // workstation entry exists yet, create an implicit default one so
    // non-clinician users still get the reuse benefit.
    if (savedScreenCal) {
      const updated = updateScreen(savedScreenCal.id, { cardWidthPx })
      if (updated) setSavedScreenCal(updated)
    } else {
      setSavedScreenCal(addScreen({ label: 'This workstation', cardWidthPx }))
    }
    // VR skips the arm's-length distance step, but brightness still happens
    // now while the phone is in hand. Claim the controller/media session from
    // this tap so the remote's button is live on every in-headset page that
    // follows, no matter which step the flow actually started on.
    if (isVr) {
      armRef.current()
      setStep('brightness')
      return
    }
    setStep('distance')
  }
  const handleRecalibrateScreen = () => {
    // Drop the active selection — the bank-card step will then run
    // from scratch and re-create / re-stamp the workstation entry.
    clearActiveScreen()
    setSavedScreenCal(null)
    setStep('screen')
  }
  // Distance is a standard-mode-only step (VR fixes the optical distance
  // at the lens focal length), so it always leads into brightness.
  const handleDistanceDone = () => {
    setStep('brightness')
  }

  const handleBrightnessDone = () => {
    setBrightnessFloor(brightness)
    if (isVr) {
      // The lens step onward runs in-headset; (re-)arm the controller now,
      // from this tap, so its button works once the phone is inserted —
      // idempotent if it was already armed leaving the screen step.
      armRef.current()
      if (wantsReactionTime) startReactionStep()
      else setStep('vr')
      return
    }
    if (!wantsReactionTime) {
      setStep('ready')
      return
    }
    startReactionStep()
  }

  // ---------- RT trial logic ----------
  const startRtTrial = useCallback(() => {
    setRtPhase('waiting')
    const delay = 1500 + Math.random() * 2000
    rtTimeoutRef.current = window.setTimeout(() => {
      rtStartRef.current = performance.now()
      setRtPhase('showing')
    }, delay)
  }, [])

  const handleRtResponse = useCallback(() => {
    if (rtPhase !== 'showing') return
    const elapsed = performance.now() - rtStartRef.current
    const newTimes = [...rtTimes, elapsed]
    setRtTimes(newTimes)
    setRtCurrent(c => c + 1)

    if (newTimes.length >= RT_TRIALS) {
      setRtPhase('done')
    } else {
      startRtTrial()
    }
  }, [rtPhase, rtTimes, startRtTrial])

  // Start first RT trial when user confirms the instruction screen
  useEffect(() => {
    if (step === 'reaction' && rtStarted && rtTimes.length === 0 && rtPhase === 'waiting') {
      startRtTrial()
    }
  // Only trigger on rtStarted change, not on rtPhase/rtTimes changes (those re-trigger via handleRtResponse)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rtStarted])

  useEffect(() => {
    if (!studyLocked || !studyMode.profile || testMode !== 'goldmann') return
    setExtendedField(studyMode.profile.extendedField)
  }, [studyLocked, studyMode.profile, testMode])

  // Cleanup timeout on unmount only
  useEffect(() => {
    return () => clearTimeout(rtTimeoutRef.current)
  }, [])

  // Keyboard handler for RT
  useEffect(() => {
    if (step !== 'reaction') return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        handleRtResponse()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, handleRtResponse])

  const handleStart = () => {
    const dims = effectiveTestDims(isMobile)
    const base = {
      pixelsPerDegree: pxPerDeg,
      viewingDistanceCm: distanceCm,
      brightnessFloor,
      reactionTimeMs: medianRt,
      screenWidthPx: dims.width,
      screenHeightPx: dims.height,
      sphericityCorrection: true,
    }
    if (isVr) {
      // Geometry is computed against the live landscape viewport — the
      // same dims the test renderer reads — so fixation lands at the
      // active lens center and max eccentricity reflects the lens half,
      // not the whole phone screen.
      const innerW = typeof window !== 'undefined' ? window.innerWidth : dims.width
      const innerH = typeof window !== 'undefined' ? window.innerHeight : dims.height
      const vrCal = {
        enabled: true as const,
        headsetPreset: vrPreset,
        lensSeparationPx: vrLensSeparationPx(innerW),
        lensCenterYOffsetPx: 0,
      }
      // 'both' calibrates the right eye first; the left pass mirrors at
      // run time. The test derives fixation from `vr` + its own eye, so
      // this fixationOffsetPx is just a consistent default.
      const activeEye = eye === 'both' ? 'right' : eye
      const vp = computeVrViewport(innerW, innerH, activeEye, vrCal)
      // The screen-edge scan can reach beyond what the lenses actually
      // image, so cap the geometric maximum at the headset's half-FOV.
      const maxEccDeg = Math.min(
        Math.floor(vrMaxEccentricityDeg(vp, innerW, innerH, pxPerDeg)),
        Math.floor(vrMaxFieldHalfDeg(vrPreset)),
      )
      onCalibrated({
        ...base,
        // The optical screen distance is the lens focal length, not the
        // arm's-length value collected for standard runs. (pixelsPerDegree
        // in `base` is already the focal-length value via `pxPerDeg`.)
        viewingDistanceCm: VR_HEADSET_SPECS[vrPreset].focalLengthMm / 10,
        maxEccentricityDeg: maxEccDeg,
        fixationOffsetPx: Math.round(vp.fixationXFromScreenCenter),
        vr: vrCal,
      }, extendedField)
      return
    }
    onCalibrated({
      ...base,
      maxEccentricityDeg: Math.floor(maxEcc),
      fixationOffsetPx,
    }, extendedField)
  }

  // ── In-headset controller wiring (phone-VR lens → ready steps) ──
  // From the lens step onward the phone is in the headset, so the patient
  // can't reach on-screen buttons. Every in-headset step is advanced by a
  // controller button press (gamepad / media-key / keyboard Enter) or the
  // visible countdown. `arm` runs from the tap that enters the flow.
  const beepRef = useRef<() => void>(() => {})
  // Single confirm action for every in-headset step, shared by the controller
  // button and the keyboard Enter/Space fallback.
  const confirmInHeadset = () => {
    if (!isVr) return
    if (step === 'vr' && !vrLensGuideActive) {
      // Advance the lens-setup page into the live focus guide. The phone must
      // be landscape (seated in the headset) first, mirroring the button's
      // disabled-while-portrait state.
      const portrait = typeof window !== 'undefined' && window.innerHeight > window.innerWidth
      if (portrait) return
      beepRef.current()
      armRef.current()
      setVrLensGuideActive(true)
    } else if (step === 'vr' && vrLensGuideActive) {
      // The lens-focus guide is the single in-headset confirm: once the rings
      // are sharp, the press starts the test directly. (It used to advance to a
      // separate 'ready' crosshair screen — a redundant second crosshair the
      // patient saw right after this one.)
      beepRef.current()
      handleStart()
    }
  }
  const remote = useRemoteInput(confirmInHeadset, { axisAsPress: false })
  useEffect(() => { beepRef.current = remote.beep }, [remote.beep])
  useEffect(() => { armRef.current = remote.arm }, [remote.arm])
  // Keyboard-remote confirm for the in-headset steps: an HID-keyboard remote's
  // OK button typically sends Enter. Held in a ref so the listener re-subscribes
  // only on step change, not on every render.
  const confirmRef = useRef(confirmInHeadset)
  useEffect(() => { confirmRef.current = confirmInHeadset })
  useEffect(() => {
    if (!isVr) return
    if (step !== 'vr') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ' || e.code === 'Space' || e.code === 'NumpadEnter') {
        e.preventDefault()
        confirmRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isVr, step])
  // Timer fallback for the in-headset lens-focus guide, so a patient whose
  // remote drops out is never stranded reaching for an unreachable button —
  // the test starts on its own. (The old separate 'ready' screen and its
  // countdown were removed; the lens guide now starts the test directly.)
  const lensGuideCountdown = useCountdownAdvance(
    isVr && step === 'vr' && vrLensGuideActive, VR_LENS_GUIDE_AUTO_SECONDS, 'vr-guide', confirmInHeadset,
  )

  // Screen size quality assessment — `isMobile` is computed at the top
  // of the function so the distance picker can use it for the floor.
  const isSmallWindow = !isMobile && (window.innerWidth < 900 || window.innerHeight < 600)

  // Per-direction field coverage (degrees from fixation to each edge)
  const fieldLeft = Math.floor(fixationScreenX / pxPerDeg)
  const fieldRight = Math.floor((window.innerWidth - fixationScreenX) / pxPerDeg)
  const fieldUp = Math.floor((window.innerHeight / 2) / pxPerDeg)
  const fieldDown = fieldUp

  // For the tested eye: map left/right to nasal/temporal
  const fieldTemporal = eye === 'right' ? fieldRight : fieldLeft
  const fieldNasal = eye === 'right' ? fieldLeft : fieldRight

  // ==================== STEP 1: Screen ====================
  if (step === 'screen') {
    return (
      <div className="min-h-[100dvh] bg-base text-body safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
        <main className="max-w-lg w-full space-y-8">
          <BackButton onClick={onBack} />
          <StepProgress current={stepNumber} total={totalSteps} />

          <h1 className="text-2xl font-heading font-bold">Screen calibration</h1>

          {isSmallWindow && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm space-y-1">
              <p className="text-amber-800 font-medium">Maximize your browser window</p>
              <p className="text-amber-700 text-xs">
                Your browser window is small — maximize it or go fullscreen (F11) to cover more visual field.
                Current coverage is only ~{Math.floor(Math.min(fieldUp, fieldLeft, fieldRight))}° from center. For RP monitoring, 30°+ is ideal.
              </p>
            </div>
          )}

          <div className="space-y-3">
            <p className="text-sm text-body">
              Hold a bank card to your screen. Drag the slider until the rectangle matches exactly.
            </p>
            <div className="flex justify-center">
              <div
                className="border-2 border-dashed border-accent rounded-lg flex items-center justify-center text-accent-light text-xs"
                style={{ width: cardWidthPx, height: cardHeightPx }}
              >
                {cardWidthPx > 200 && 'BANK CARD'}
              </div>
            </div>
            <input
              type="range"
              min={150}
              max={600}
              value={cardWidthPx}
              onChange={e => setCardWidthPx(Number(e.target.value))}
              aria-label="Bank card width — drag to match your physical card"
              className="w-full accent-amber-500"
            />
          </div>

          {studyLocked && studyMode.profile ? (
            <div className="rounded-xl border border-teal/20 bg-teal/10 px-4 py-3 text-sm space-y-1">
              <p className="font-medium text-teal">Study profile active</p>
              <p className="text-teal/80 text-xs leading-relaxed">
                {studyMode.profile.label} ({studyMode.profile.id}, v{studyMode.profile.version}) locks advanced settings for this run.
              </p>
            </div>
          ) : (
            <AdvancedSettingsPanel testMode={testMode} />
          )}

          <div className="action-footer">
            <button
              onClick={handleScreenDone}
              className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
            >Next</button>
          </div>
        </main>
      </div>
    )
  }

  // ==================== STEP 2: Viewing distance ====================
  if (step === 'distance') {
    return (
      <div className="min-h-[100dvh] bg-base text-body safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
        <main className="max-w-lg w-full space-y-8">
          <BackButton onClick={() => setStep('screen')} />
          <StepProgress current={stepNumber} total={totalSteps} />

          <h1 className="text-2xl font-heading font-bold">Viewing distance</h1>

          {/* Rotate-to-landscape nudge — only on phones, only while
              portrait. The field-coverage diagram below shows the same
              info quantitatively, but a lot of users won't connect "T 8°"
              to "I should turn my phone sideways" without an explicit
              prompt. Re-renders via the viewport-tick effect set up
              above, so flipping the phone hides the card immediately. */}
          {isMobile && window.innerHeight > window.innerWidth && (
            <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 flex items-center gap-3">
              <svg width="52" height="32" viewBox="0 0 52 32" fill="none" className="text-accent flex-shrink-0" aria-hidden="true">
                {/* Portrait phone (faded) */}
                <rect x="3" y="3" width="11" height="22" rx="1.5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.55" fill="none" />
                <line x1="6.5" y1="6" x2="10.5" y2="6" stroke="currentColor" strokeWidth="1" strokeOpacity="0.55" strokeLinecap="round" />
                {/* Arrow */}
                <path d="M 19 14 L 30 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M 27 11 L 30 14 L 27 17" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                {/* Landscape phone */}
                <rect x="34" y="8" width="15" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <line x1="37" y1="11" x2="37" y2="18" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              </svg>
              <div className="text-sm">
                <p className="text-ink font-medium">Turn your phone sideways</p>
                <p className="text-muted text-xs mt-0.5">Landscape gives you a wider field to test.</p>
              </div>
            </div>
          )}

          {savedScreenCal && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-teal/20 bg-teal/10 px-3 py-2 text-xs text-teal/90">
              <span>Using saved screen calibration for this display.</span>
              <button
                type="button"
                onClick={handleRecalibrateScreen}
                className="text-teal hover:text-teal/80 underline decoration-dotted"
              >
                recalibrate
              </button>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm text-body">
              How far is your eye from the screen?
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setDistanceCm(d => Math.max(minDistanceCm, d - 5))}
                className="w-11 h-11 rounded bg-elevated hover:bg-overlay text-lg"
                aria-label="Decrease viewing distance"
              >−</button>
              <span className="text-2xl font-mono w-20 text-center" aria-live="polite">{distanceCm} cm</span>
              <button
                onClick={() => setDistanceCm(d => Math.min(100, d + 5))}
                className="w-11 h-11 rounded bg-elevated hover:bg-overlay text-lg"
                aria-label="Increase viewing distance"
              >+</button>
            </div>
            {/* Suggested distance — computed from screen size + card
                calibration so the narrowest useful meridian (temporal and
                vertical; nasal excluded because fixation is offset 20%
                toward the nose) reaches a clinically useful angle
                (~40° from fixation). Taking vertical into account matters
                on 16:9 screens where halfHeight is only ~0.56·halfWidth —
                a width-only suggestion would still put vertical reach at
                ~25° and trip the coverage heads-up. Extended-field mode
                (Goldmann only) shifts fixation ±30% of fullHeight so the
                vertical constraint is relaxed to halfH + 0.3·fullH; this
                recomputes live when the toggle changes. Rounded to the
                nearest 5 cm and offered with a one-tap apply button so
                advanced users can still pick their own distance. */}
            {(() => {
              const { width: screenWidthPx, height: screenHeightPx } = effectiveTestDims(isMobile)
              const screenWidthCm = pxPerMm > 0 ? screenWidthPx / pxPerMm / 10 : 0
              const screenHeightCm = pxPerMm > 0 ? screenHeightPx / pxPerMm / 10 : 0
              const targetAngleDeg = 40
              const tan = Math.tan((targetAngleDeg * Math.PI) / 180)
              const temporalCm = screenWidthCm * 0.7
              const verticalFraction = testMode === 'goldmann' && extendedField ? 0.8 : 0.5
              const verticalCm = screenHeightCm * verticalFraction
              const limitCm = Math.min(temporalCm, verticalCm)
              const rawSuggested = limitCm / tan
              const suggested = Math.max(defaultMinDistanceCm, Math.min(100, Math.round(rawSuggested / 5) * 5))
              if (screenWidthCm < 5) return null  // card not yet calibrated
              const isMatch = Math.abs(suggested - distanceCm) <= 2
              // Compute the angle that the *clamped* suggested distance
              // actually achieves on the narrowest meridian. On small
              // phones the unclamped raw is well under 20 cm, so the
              // clamp leaves the achievable field at, say, ~25–30°, not
              // 40°. Report the truth instead of the wish.
              const achievedAngleDeg = Math.round((Math.atan(limitCm / suggested) * 180) / Math.PI)
              return (
                <div className="text-[11px] text-muted flex items-center gap-2">
                  <span>
                    Suggested: <span className="text-body font-mono">{suggested} cm</span>{' '}
                    <span className="text-muted">
                      (field reaches ~{achievedAngleDeg}° on all sides except the nose)
                    </span>
                  </span>
                  {!isMatch && (
                    <button
                      type="button"
                      onClick={() => setDistanceCm(suggested)}
                      className="text-accent hover:text-accent-light underline decoration-dotted"
                    >
                      use
                    </button>
                  )}
                </div>
              )
            })()}
          </div>

          {/* Live field coverage diagram — updates with distance & card size */}
          {(() => {
            const { width: fullW, height: fullH } = effectiveTestDims(isMobile)
            const fullFixX = fullW / 2 + fixationOffsetPx
            // Extended-field mode (Goldmann only) runs four extra passes
            // with fixation shifted ±30% of fullHeight (up/down) and
            // ±30% of fullWidth (left/right), so achievable reach grows
            // by that shift on every side. Reflect the achievable number
            // here so the T·N·S·I readout matches what the test will
            // actually probe.
            const extended = testMode === 'goldmann' && extendedField
            const horizBoostPx = extended ? fullW * 0.3 : 0
            const fTemporal = eye === 'right'
              ? Math.floor(((fullW - fullFixX) + horizBoostPx) / pxPerDeg)
              : Math.floor((fullFixX + horizBoostPx) / pxPerDeg)
            const fNasal = eye === 'right'
              ? Math.floor((fullFixX + horizBoostPx) / pxPerDeg)
              : Math.floor(((fullW - fullFixX) + horizBoostPx) / pxPerDeg)
            const verticalReachPx = extended
              ? fullH / 2 + fullH * 0.3
              : fullH / 2
            const fUp = Math.floor(verticalReachPx / pxPerDeg)
            const fDown = fUp
            const diagramMax = 100
            const dScale = 120 / diagramMax

            // Normal monocular field polygon
            const monocularPts = Array.from({ length: 36 }, (_, i) => {
              const angleDeg = i * 10
              const rad = (angleDeg * Math.PI) / 180
              const cos = Math.cos(rad)
              const sin = Math.sin(rad)
              const tExt = eye === 'right' ? 90 : 60
              const nExt = eye === 'right' ? 60 : 90
              const hExt = cos >= 0 ? tExt : nExt
              const vExt = sin >= 0 ? 60 : 70
              const extent = Math.abs(cos) < 0.001 ? vExt : Math.abs(sin) < 0.001 ? hExt
                : 1 / Math.sqrt((cos / hExt) ** 2 + (sin / vExt) ** 2)
              const r = Math.min(extent * dScale, 135)
              return `${150 + r * cos},${150 - r * sin}`
            }).join(' ')

            // Screen testable polygon (+ extended variants). fxOffset /
            // fyOffset move the fixation dot relative to screen centre,
            // which is how each extended pass relaxes the reach on the
            // far side.
            const screenPoly = (fxOffset: number, fyOffset: number) => Array.from({ length: 36 }, (_, i) => {
              const angleDeg = i * 10
              const rad = (angleDeg * Math.PI) / 180
              const dx = Math.cos(rad)
              const dy = -Math.sin(rad)
              const halfW = fullW / 2
              const halfH = fullH / 2
              const fx = fixationOffsetPx + fxOffset
              let t = 9999
              if (dx > 0.001) t = Math.min(t, (halfW - fx) / dx)
              if (dx < -0.001) t = Math.min(t, (-halfW - fx) / dx)
              if (dy > 0.001) t = Math.min(t, (halfH - fyOffset) / dy)
              if (dy < -0.001) t = Math.min(t, (-halfH - fyOffset) / dy)
              const eccDeg = t / pxPerDeg
              const r = Math.min(eccDeg * dScale, 135)
              return { deg: eccDeg, pt: `${150 + r * Math.cos(rad)},${150 - r * Math.sin(rad)}` }
            })
            const normalPoly = screenPoly(0, 0)
            const normalPts = normalPoly.map(p => p.pt).join(' ')

            // Extended union — four passes shifting fixation up/down/left/right
            const vShift = fullH * 0.3
            const hShift = fullW * 0.3
            const extPolys = [
              screenPoly(0, -vShift),
              screenPoly(0, vShift),
              screenPoly(-hShift, 0),
              screenPoly(hShift, 0),
            ]
            const extPts = Array.from({ length: 36 }, (_, i) => {
              const maxDeg = Math.max(normalPoly[i].deg, ...extPolys.map(p => p[i].deg))
              const r = Math.min(maxDeg * dScale, 135)
              const rad = (i * 10 * Math.PI) / 180
              return `${150 + r * Math.cos(rad)},${150 - r * Math.sin(rad)}`
            }).join(' ')

            return (
              <div className="bg-surface/60 rounded-2xl border border-line p-4 text-center space-y-3">
                <p className="text-xs text-muted font-medium">Field coverage</p>
                <svg viewBox="0 0 300 300" className="mx-auto w-full" style={{ maxWidth: 280 }}>
                  {/* Reference rings */}
                  {[10, 20, 30, 40, 50, 60, 70, 80, 90].map(deg => {
                    const r = deg * dScale
                    return (
                      <g key={deg}>
                        <circle cx={150} cy={150} r={r} fill="none" stroke="#1e293b" strokeWidth={0.5} />
                        {deg % 30 === 0 && (
                          <text x={150 + r + 3} y={147} fill="#475569" fontSize={8}>{deg}°</text>
                        )}
                      </g>
                    )
                  })}
                  {/* 20° RP threshold */}
                  <circle cx={150} cy={150} r={20 * dScale} fill="none" stroke="#f59e0b" strokeWidth={1} strokeDasharray="2,3" strokeOpacity={0.5} />
                  {/* Normal monocular field */}
                  <polygon points={monocularPts} fill="none" stroke="#475569" strokeWidth={1} strokeDasharray="4,3" strokeOpacity={0.7} />
                  {/* Extended area */}
                  {extendedField && (
                    <polygon points={extPts} fill="#22c55e" fillOpacity={0.08} stroke="#22c55e" strokeWidth={1} strokeOpacity={0.5} strokeDasharray="3,2" />
                  )}
                  {/* Screen-testable area */}
                  <polygon points={normalPts} fill="#3b82f6" fillOpacity={0.15} stroke="#3b82f6" strokeWidth={1.5} strokeOpacity={0.7} />
                  {/* Fixation */}
                  <circle cx={150} cy={150} r={3} fill="#fbbf24" />
                  {/* Labels */}
                  <text x={288} y={155} fill="#94a3b8" fontSize={11} textAnchor="end">{eye === 'right' ? 'T' : 'N'}</text>
                  <text x={12} y={155} fill="#94a3b8" fontSize={11}>{eye === 'right' ? 'N' : 'T'}</text>
                  <text x={150} y={16} fill="#94a3b8" fontSize={11} textAnchor="middle">S</text>
                  <text x={150} y={296} fill="#94a3b8" fontSize={11} textAnchor="middle">I</text>
                </svg>
                <div className="flex gap-3 justify-center flex-wrap text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-0 border-t border-dashed" style={{ borderColor: '#475569' }} /> normal field
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-0 border-t" style={{ borderColor: '#3b82f6' }} /> testable
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-0 border-t border-dashed" style={{ borderColor: '#f59e0b' }} /> 20° RP
                  </span>
                  {extendedField && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-0 border-t border-dashed" style={{ borderColor: '#22c55e' }} /> extended
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted">
                  T {fTemporal}° · N {fNasal}° · S {fUp}° · I {fDown}°
                </p>

                {/* Extended field toggle — Goldmann only. Static test
                    doesn't implement the extra extended-field passes, so
                    the option is hidden for it to avoid offering a
                    setting that would have no effect. */}
                {testMode === 'goldmann' && !studyLocked && (
                  <button
                    onClick={() => setExtendedField(v => !v)}
                    role="switch"
                    aria-checked={extendedField}
                    className={`w-full text-left px-4 py-3 rounded-xl border transition-colors ${
                      extendedField
                        ? 'bg-green-600/10 border-green-500/50'
                        : 'bg-surface border-line hover:border-line-strong'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-xs text-body">Extended field mode</p>
                        <p className="text-xs text-muted mt-0.5">
                          4 extra passes with shifted fixation for more coverage on every side (~4 min extra)
                        </p>
                      </div>
                      <div className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors flex-shrink-0 ml-2 ${
                        extendedField ? "bg-accent justify-end" : "bg-slate-300 justify-start"
                      }`}>
                        <div className="w-4 h-4 rounded-full bg-white" />
                      </div>
                    </div>
                  </button>
                )}
                {testMode === 'goldmann' && studyLocked && studyMode.profile && (
                  <div className="w-full rounded-xl border border-teal/20 bg-teal/10 px-4 py-3 text-left">
                    <p className="font-medium text-xs text-teal">Extended field mode</p>
                    <p className="mt-0.5 text-xs text-teal/80">
                      Locked by study profile: {studyMode.profile.extendedField ? 'enabled' : 'disabled'}.
                    </p>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Goldmann coverage note. Sits underneath the coverage diagram
              so the user can adjust distance in place.
              Trigger: III4e (clinical-standard isopter) can't be bounded
              in one of the meridians that actually matters for RP
              monitoring — temporal, superior, inferior. Nasal is excluded
              on purpose:
              - Fixation is deliberately shifted 20% toward the nose so
                the temporal half of the screen gets more visual angle.
                That means nasal reach is ~0.3·fullW/distance, always
                less than temporal. Any "suggested" viewing distance
                that puts the temporal edge at 40° puts the nasal edge
                at only ~27° — it would trip this warning on every
                reasonable setup, drowning out real ones.
              - Nasal III4e is also anatomically capped near the nose,
                so the number we can actually measure saturates.
              V4e is also excluded: its temporal-side extent (≥90° in a
              healthy eye) is unreachable on essentially any consumer
              display at any sane viewing distance, and flagging it is
              noise for the same reason.
              Extended-field mode runs 2 extra passes with fixation
              shifted ±30% of screen height, so achievable UP/DOWN
              extents reach halfH + 0.3·fullH. Horizontal extents don't
              change. Factor that in so the note clears when a
              purely-vertical shortfall is covered by extended mode. */}
          {testMode === 'goldmann' && (() => {
            const { width: fullW, height: fullH } = effectiveTestDims(isMobile)
            const fullFixX = fullW / 2 + fixationOffsetPx
            const fTemporal = eye === 'right'
              ? Math.floor((fullW - fullFixX) / pxPerDeg)
              : Math.floor(fullFixX / pxPerDeg)
            const verticalReachPx = extendedField
              ? fullH / 2 + fullH * 0.3
              : fullH / 2
            const fUp = Math.floor(verticalReachPx / pxPerDeg)
            const fDown = fUp
            // Nasal deliberately not in this min — see comment above.
            const narrowest = Math.min(fTemporal, fUp, fDown)
            // III4e trigger threshold: healthy outer extent ~40°. Below
            // that, the clinical-standard isopter can't be fully plotted.
            if (narrowest >= 40) return null
            // Vertical-only shortfall → extended mode would fix it.
            const vertLimited = !extendedField && fTemporal >= 40
            return (
              <p className="text-xs text-muted leading-relaxed">
                <span className="text-muted">Heads-up:</span> your screen
                only reaches {narrowest}° from the yellow dot (not counting
                the nose side, which is naturally blocked by your nose), so
                parts of the outer field can't be fully tested — results
                there will say "at least N°" instead of a precise edge.
                {vertLimited
                  ? ' Turn on extended-field mode above, or move closer and bump the distance down, to test more of the field.'
                  : ' Move closer and bump the distance down to test more of the field.'}
              </p>
            )
          })()}

          <div className="action-footer">
            <button
              onClick={handleDistanceDone}
              className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
            >Next</button>
          </div>
        </main>
      </div>
    )
  }

  // NOTE: Blindspot position verification used to live here as a dedicated
  // calibration step, but it's been moved into the test component itself
  // (see PositionCheckOverlay) so it fires right before the countdown —
  // the patient reads "cover your X eye and sit at Y cm" on the test-
  // instructions screen, taps Ready, and the position check runs in-place
  // instead of mid-calibration where the user would have to re-settle
  // before the actual measurement begins.

  // ==================== STEP 3: Brightness ====================
  if (step === 'brightness') {
    return (
      <div className="min-h-[100dvh] bg-base text-body safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
        <main className="max-w-lg w-full space-y-8">
          <BackButton onClick={() => setStep(isVr ? 'screen' : 'distance')} />

          <StepProgress current={stepNumber} total={totalSteps} />
          <h1 className="text-2xl font-heading font-bold">Find your dimmest visible dot</h1>

          <div className="space-y-2 text-sm text-body">
            <p>We need to know the dimmest dot your screen can show.</p>
            <ol className="list-decimal list-inside space-y-1 text-muted">
              <li>Start high — drag the slider right until you clearly see the white dot.</li>
              <li>Slowly drag left. Stop the moment the dot disappears.</li>
              <li>Nudge back right by one step so the dot is just barely visible again.</li>
            </ol>
            {/* Set the room now, before this reading bakes in: the dimmest-dot
                value depends on your current lighting, so the test must run in
                the same conditions you calibrate in. */}
            <p className="text-muted">
              One-time setup (~15 seconds). Do this in the same dim room you'll take the test in —
              the dimmest dot depends on your lighting.
            </p>
          </div>

          {/* The dot is semi-transparent WHITE, so this preview box must
              stay dark for it to be visible at all — and to mean anything
              clinically (it mirrors the dim test surface the real stimuli
              are drawn on). It was accidentally swept to the light page
              token during the clinical redesign, which made the dot all
              but invisible even at max brightness. Kept a dark instrument
              panel inside the light page, like the field-map plots. */}
          <div className="relative w-full h-48 bg-black rounded-xl border border-slate-800 flex items-center justify-center">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: `rgba(255, 255, 255, ${brightness})` }}
            />
            <span className="absolute top-2 right-3 text-xs text-slate-400 font-mono">
              {(brightness * 100).toFixed(1)}%
            </span>
          </div>

          {/* Big −/+ steppers are the primary fine control. The dimmest
              setting drives the slider thumb to the far end of the track,
              where it's awkward to grab one-handed while holding the phone;
              tapping a single step avoids that entirely. The slider stays for
              coarse moves but is inset (px-2) and given a taller touch area so
              its thumb never sits flush against the screen edge. */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setBrightness(b => Math.max(0.005, +(b - 0.005).toFixed(3)))}
              className="flex-1 h-14 rounded-xl bg-elevated hover:bg-overlay text-3xl font-medium leading-none"
              aria-label="Dimmer — decrease brightness one step"
            >−</button>
            <span className="text-2xl font-mono w-24 text-center tabular-nums" aria-live="polite">
              {(brightness * 100).toFixed(1)}%
            </span>
            <button
              onClick={() => setBrightness(b => Math.min(0.5, +(b + 0.005).toFixed(3)))}
              className="flex-1 h-14 rounded-xl bg-elevated hover:bg-overlay text-3xl font-medium leading-none"
              aria-label="Brighter — increase brightness one step"
            >+</button>
          </div>

          <div className="px-2">
            <input
              type="range"
              min={0.5}
              max={50}
              step={0.5}
              value={brightness * 100}
              onChange={e => setBrightness(Number(e.target.value) / 100)}
              aria-label={`Brightness level: ${(brightness * 100).toFixed(1)}%`}
              className="w-full accent-amber-500 py-3"
            />
            <div className="flex gap-2 text-xs text-muted">
              <span>← dimmer (invisible)</span>
              <span className="flex-1" />
              <span>brighter (clearly visible) →</span>
            </div>
          </div>

          <div className="action-footer">
            <button
              onClick={handleBrightnessDone}
              className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
            >This is the dimmest I can see — continue</button>
          </div>
        </main>
      </div>
    )
  }

  // ==================== STEP 4: Reaction time ====================
  if (step === 'reaction') {
    if (rtPhase === 'done' || rtTimes.length >= RT_TRIALS) {
      return (
        <div className="min-h-[100dvh] bg-base text-body safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
          <main className="max-w-lg w-full space-y-8">
            <BackButton onClick={() => { setRtTimes([]); setRtPhase('waiting'); setRtStarted(false); setStep('brightness') }} />
            <StepProgress current={stepNumber} total={totalSteps} />
            <h1 className="text-2xl font-heading font-bold">Reaction time measured</h1>

            <div className="bg-surface rounded-2xl border border-line p-5 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted">Your median RT</span>
                <span className="font-mono text-ink">{medianRt.toFixed(0)} ms</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted">Position compensation</span>
                <span className="font-mono text-ink">
                  +{((3 * medianRt) / 1000).toFixed(1)}° per reading
                </span>
              </div>
              <p className="text-xs text-muted">
                At 3°/s stimulus speed, your reaction time shifts each recorded position by{' '}
                {((3 * medianRt) / 1000).toFixed(1)}°. This is automatically corrected.
              </p>
            </div>

            <div className="text-xs text-muted">
              Individual times: {rtTimes.map(t => `${t.toFixed(0)}ms`).join(', ')}
            </div>

            <div className="action-footer">
              <button
                onClick={() => { if (isVr) remote.arm(); setStep(isVr ? 'vr' : 'ready') }}
                className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
              >Next</button>
            </div>
          </main>
        </div>
      )
    }

    // RT instruction screen
    if (!rtStarted) {
      return (
        <div className="min-h-[100dvh] bg-base text-body safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
          <main className="max-w-lg w-full space-y-8">
            <BackButton onClick={() => setStep('brightness')} />

            <StepProgress current={stepNumber} total={totalSteps} />
            <h1 className="text-2xl font-heading font-bold">Reaction time test</h1>

            <div className="space-y-3 text-sm text-body">
              <p>
                We'll measure your reaction time with {RT_TRIALS} quick trials.
              </p>
              <div className="bg-surface rounded-2xl border border-line p-4 space-y-2">
                <p>1. Stare at the center of the screen</p>
                <p>2. A white dot will appear after a random delay</p>
                <p>3. <strong className="text-ink">{isMobile ? 'Tap the screen' : 'Tap the screen or press Space'}</strong> as fast as you can when you see it</p>
              </div>
              <p className="text-muted text-xs">
                Your reaction time is used to compensate for response delay during the visual field test, improving accuracy.
              </p>
            </div>

            <div className="action-footer">
              <button
                onClick={() => setRtStarted(true)}
                className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
              >Start</button>
            </div>
          </main>
        </div>
      )
    }

    // Active RT trial
    return (
      <div
        className="min-h-screen bg-page text-white flex items-center justify-center select-none cursor-pointer"
        onPointerDown={handleRtResponse}
        role="application"
        aria-label="Reaction time trial — press Space or tap when you see the dot"
      >
        <main className="text-center space-y-6">
          <p className="text-xs text-slate-400">Step 3 of 3 — Reaction time</p>
          <p className="text-slate-300 text-sm max-w-xs mx-auto" aria-live="assertive">
            {rtPhase === 'waiting'
              ? 'Wait for the dot to appear…'
              : isMobile ? 'Tap NOW!' : 'Press Space or tap NOW!'}
          </p>

          {/* Dot area */}
          <div className="w-32 h-32 mx-auto flex items-center justify-center">
            {rtPhase === 'showing' && (
              <div className="w-4 h-4 rounded-full bg-white animate-pulse" />
            )}
          </div>

          <p className="text-slate-400 text-xs">
            Trial {rtCurrent + 1} of {RT_TRIALS}
          </p>
        </main>
      </div>
    )
  }

  // ==================== STEP: Phone VR lens setup ====================
  if (step === 'vr') {
    const portrait = typeof window !== 'undefined' && window.innerHeight > window.innerWidth
    const innerW = typeof window !== 'undefined' ? window.innerWidth : 812
    const innerH = typeof window !== 'undefined' ? window.innerHeight : 375
    const lensSepPx = vrLensSeparationPx(innerW)
    // Mini live preview of the split-screen guides, scaled to a fixed
    // width while preserving the landscape aspect ratio.
    const previewW = 280
    const previewH = Math.max(80, Math.round((previewW * innerH) / innerW))
    const scale = previewW / innerW
    const centerX = previewW / 2
    const centerY = previewH / 2
    const lensDx = (lensSepPx / 2) * scale
    const lensR = Math.min(previewH, previewW / 2) * 0.32
    if (vrLensGuideActive) {
      const activeEye = eye === 'both' ? 'right' : eye
      const vrCal = {
        enabled: true as const,
        headsetPreset: vrPreset,
        lensSeparationPx: lensSepPx,
        lensCenterYOffsetPx: 0,
      }
      const vp = computeVrViewport(innerW, innerH, activeEye, vrCal)
      const lensCenterX = innerW / 2 + vp.fixationXFromScreenCenter
      const lensCenterY = innerH / 2 + vp.fixationYFromScreenCenter
      const activeCenterX = vp.originX + vp.width / 2
      const guideSize = Math.max(64, Math.min(vp.width - 48, innerH - 64, 170))
      return (
        <div
          className="fixed inset-0 bg-black text-white select-none cursor-pointer"
          role="application"
          aria-label="Headset guide — align the lens to the guide and press the controller button to continue"
          onPointerDown={confirmInHeadset}
        >
          <svg
            className="absolute overflow-visible"
            width={guideSize}
            height={guideSize}
            viewBox="-50 -50 100 100"
            style={{
              left: lensCenterX,
              top: lensCenterY,
              transform: 'translate(-50%, -50%)',
              zIndex: 22,
            }}
            aria-hidden
          >
            {[44, 30, 16].map(r => (
              <circle key={r} cx="0" cy="0" r={r} fill="none" stroke="#2dd4bf" strokeWidth="1" strokeOpacity="0.72" />
            ))}
            <line x1="-44" y1="0" x2="44" y2="0" stroke="#2dd4bf" strokeWidth="0.8" strokeOpacity="0.55" />
            <line x1="0" y1="-44" x2="0" y2="44" stroke="#2dd4bf" strokeWidth="0.8" strokeOpacity="0.55" />
            <circle cx="0" cy="0" r="2.4" fill="#2dd4bf" />
          </svg>
          <div
            className="absolute text-center px-3 text-[11px] leading-snug text-slate-400"
            style={{
              left: activeCenterX,
              bottom: 22,
              transform: 'translateX(-50%)',
              width: vp.width - 36,
              zIndex: 22,
            }}
          >
            Focus until the rings are sharp, then press the button
            {lensGuideCountdown != null && (
              <span className="block mt-1 text-slate-500">continuing in {lensGuideCountdown}s</span>
            )}
          </div>
          <VrTestSurface viewport={vp} innerWidth={innerW} showDivider={false} />
        </div>
      )
    }
    return (
      <div className="min-h-[100dvh] bg-base text-body safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
        <main className="max-w-lg w-full space-y-8">
          <BackButton onClick={() => { setVrLensGuideActive(false); setStep(wantsReactionTime ? 'reaction' : 'brightness') }} />
          <StepProgress current={stepNumber} total={totalSteps} />

          <h1 className="text-2xl font-heading font-bold">Headset lens setup</h1>

          {portrait ? (
            <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-4 flex items-center gap-3">
              <svg width="52" height="32" viewBox="0 0 52 32" fill="none" className="text-accent flex-shrink-0" aria-hidden="true">
                <rect x="3" y="3" width="11" height="22" rx="1.5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.55" fill="none" />
                <path d="M 19 14 L 30 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M 27 11 L 30 14 L 27 17" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                <rect x="34" y="8" width="15" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
              <div className="text-sm">
                <p className="text-ink font-medium">Turn your phone sideways</p>
                <p className="text-muted text-xs mt-0.5">Phone VR runs in landscape. Rotate the phone to continue.</p>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-body">
                Your headset lens spacing is
                computed from the headset IPD ({VR_HEADSET_SPECS[vrPreset].ipdMm} mm)
                and your card-based screen scale. Keep the phone in your hand
                for this page; the next screen is the one you read through the
                headset.
              </p>
              <p className="text-xs text-accent/90">
                After the guide appears, slide the phone into the headset and
                use the remote button or the on-screen countdown. You won't
                touch the screen again until your results.
              </p>

              {/* Live split-screen focus target. The fine concentric rings
                  and crosshair give the eye detail to judge sharpness
                  against while turning the headset's mechanical focus
                  wheel; the spacing is preset to the headset's known
                  optics. */}
              <div className="bg-black rounded-2xl border border-line p-3">
                <svg viewBox={`0 0 ${previewW} ${previewH}`} className="mx-auto w-full" style={{ maxWidth: previewW }} aria-hidden="true">
                  <rect x={0} y={0} width={previewW} height={previewH} fill="#000" />
                  <line x1={centerX} y1={0} x2={centerX} y2={previewH} stroke="#27272a" strokeWidth={1} strokeDasharray="4,4" />
                  {[centerX - lensDx, centerX + lensDx].map((cx, i) => (
                    <g key={i}>
                      {[lensR, lensR * 0.66, lensR * 0.33].map((r, j) => (
                        <circle key={j} cx={cx} cy={centerY} r={r} fill="none" stroke="#2dd4bf" strokeWidth={1} strokeOpacity={0.7} />
                      ))}
                      <line x1={cx - lensR} y1={centerY} x2={cx + lensR} y2={centerY} stroke="#2dd4bf" strokeWidth={0.75} strokeOpacity={0.5} />
                      <line x1={cx} y1={centerY - lensR} x2={cx} y2={centerY + lensR} stroke="#2dd4bf" strokeWidth={0.75} strokeOpacity={0.5} />
                      <circle cx={cx} cy={centerY} r={2} fill="#2dd4bf" />
                    </g>
                  ))}
                </svg>
              </div>
              <p className="text-xs text-muted text-center">
                Lens separation: <span className="font-mono">{lensSepPx}px</span>
              </p>
            </>
          )}

          <div className="action-footer">
            <button
              onClick={confirmInHeadset}
              disabled={portrait}
              className={`w-full py-3 rounded-xl text-lg font-medium ${portrait ? "bg-elevated text-muted cursor-not-allowed" : "btn-primary text-white"}`}
            >
              {portrait ? 'Rotate to continue' : 'Continue'}
            </button>
          </div>
        </main>
      </div>
    )
  }

  // ==================== STEP 5: Ready (standard mode only) ====================
  // Phone-VR no longer has its own Ready screen: the lens-focus guide is the
  // final in-headset confirm and starts the test directly (see
  // confirmInHeadset), which removes the redundant second crosshair the patient
  // used to see right after the focus guide. Standard mode keeps the summary
  // card + Start button below.

  return (
    <div className="min-h-[100dvh] bg-base text-body safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
      <main className="max-w-lg w-full space-y-8">
        <BackButton onClick={() => setStep(wantsReactionTime ? 'reaction' : 'brightness')} />

        <h1 className="text-2xl font-heading font-bold">Ready to test</h1>

        <div className="bg-surface rounded-2xl border border-line p-5 space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted">Test type</span>
            <span>{testMode === 'static' ? 'Static test' : 'Goldmann (kinetic)'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Eye</span>
            <span>{eye === 'right' ? 'OD (Right)' : 'OS (Left)'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Field coverage</span>
            <span>T {fieldTemporal}° · N {fieldNasal}° · S {fieldUp}° · I {fieldDown}°</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Brightness floor</span>
            <span className="font-mono">{(brightnessFloor * 100).toFixed(1)}%</span>
          </div>
          {wantsReactionTime && (
            <div className="flex justify-between">
              <span className="text-muted">Reaction time</span>
              <span className="font-mono">{medianRt.toFixed(0)} ms (+{((3 * medianRt) / 1000).toFixed(1)}°)</span>
            </div>
          )}
          {testMode === 'static' ? (() => {
            // Static Quick forces the 10-2 grid (central ±9°) regardless
            // of the user's Advanced Settings selection. We display the
            // effective grid, not what's saved in settings — otherwise
            // the Ready screen would lie about what's about to happen.
            const effectiveGrid: StaticGridPattern = speedMode === 'quick' ? '10-2' : advanced.staticGridPattern
            const info = STATIC_GRID_INFO[effectiveGrid]
            const points = effectiveGrid === 'custom'
              ? countCustomGridPoints(advanced.customGrid)
              : info.points
            return (
              <>
                {speedMode === 'quick' && (
                  <div className="flex justify-between">
                    <span className="text-muted">Mode</span>
                    <span>Quick scan (central 10°)</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted">Grid</span>
                  <span>{info.label} — {points} points</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Stimuli</span>
                  <span>Goldmann III, 0–35 dB</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Staircase</span>
                  <span>4-2 dB adaptive</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Pacing</span>
                  <span>Timed flashes — tap when seen</span>
                </div>
              </>
            )
          })() : speedMode === 'quick' ? (
            <>
              <div className="flex justify-between">
                <span className="text-muted">Mode</span>
                <span>Quick scan (single isopter)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Stimulus</span>
                <span>III4e only — 12 meridians</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Adaptive</span>
                <span>Outlier retest only</span>
              </div>
            </>
          ) : (
            <>
              <div className="flex justify-between">
                <span className="text-muted">Stimuli</span>
                <span>V4e, III4e, III2e, I4e, I2e</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Adaptive</span>
                <span>Yes — problem areas retested</span>
              </div>
            </>
          )}
        </div>

        {/* Test instructions */}
        <div className="bg-surface/60 border border-line rounded-2xl px-4 py-3 space-y-2 text-xs text-muted">
          <p className="text-sm text-body font-medium mb-2">
            Testing <span className="text-ink">{formatEyeLabelLong(eye)}</span>
          </p>
          <div className="flex gap-2 items-start">
            <span className="text-yellow-500 mt-0.5">&#9790;</span>
            <p><span className="text-body font-medium">Dark room.</span> Perform the test in a dark or dimly lit room for best contrast, just like clinical perimetry.</p>
          </div>
          <div className="flex gap-2 items-start">
            <span className="text-green-400 mt-0.5">&#9673;</span>
            <p><span className="text-body font-medium">Fixation.</span> Keep your eye fixed on the yellow dot during the test. Only press when you see a stimulus in your peripheral vision.</p>
          </div>
          {!isMobile && (
            <div className="flex gap-2 items-start">
              <span className="text-muted mt-0.5">&#9099;</span>
              <p>
                <span className="text-body font-medium">Pause or leave.</span> Press{' '}
                <kbd className="px-1.5 py-0.5 bg-slate-100 border border-line rounded text-[10px] font-mono text-body">Esc</kbd>{' '}
                any time to pause the test or exit.
              </p>
            </div>
          )}
        </div>

        {/* Duration estimates are advertised on the home screen next to
            the speed toggle — no need to repeat them here and risk the
            two surfaces drifting out of sync. */}
        <p className="text-xs text-muted">
          {testMode === 'static'
            ? speedMode === 'quick'
              ? <>Central 10° only (HFA 10-2 grid). Best for tracking <strong className="text-amber-300/80 font-medium">macular involvement</strong> — not the right scan for monitoring RP, where the peripheral field shrinks first; use Normal or the Goldmann test for that.</>
              : 'Briefly-flashed dots at 54 fixed grid points. Tap the screen each time you see one.'
            : speedMode === 'quick'
              ? 'One pass at the III4e isopter — the clinical reportable boundary. Use this for serial monitoring between full tests; a full test maps inner isopters too and is more sensitive to relative scotomas.'
              : `The test runs in phases: initial scan, adaptive refinement, outer boundary, sensitivity, and central detail.${extendedField ? ' Plus 2 extended-field passes (up/down).' : ''}`
          }
        </p>

        {/* Field-coverage warning ("V4e can't be bounded at this distance")
            lives on the viewing-distance screen, next to the distance
            picker, so users can adjust in place instead of navigating
            back from this summary. */}

        <div className="action-footer">
          <button
            onClick={handleStart}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >Start test</button>
        </div>
      </main>
    </div>
  )
}
