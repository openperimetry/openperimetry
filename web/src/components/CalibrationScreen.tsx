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
import type { CalibrationData, Eye, RunSpeedMode } from '../types'
import { BackButton } from './AccessibleNav'
import { CALIBRATION } from '../constants'
import { formatEyeLabelLong } from '../eyeLabels'
import { AdvancedSettingsPanel } from './AdvancedSettingsPanel'
import { useAdvancedSettings } from '../advancedSettings'
import { STATIC_GRID_INFO, countCustomGridPoints } from '../grids'
import type { StaticGridPattern } from '../grids'
import { useStudyMode } from '../studyMode'
import { isPhoneLikeDevice } from '../deviceMode'
import {
  addScreen,
  clearActiveScreen,
  getActiveScreen,
  updateScreen,
} from '../screenCalibration'

const CREDIT_CARD_WIDTH_MM = 85.6
const CREDIT_CARD_HEIGHT_MM = 53.98
const RT_TRIALS = 5

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
}

type Step = 'screen' | 'distance' | 'brightness' | 'reaction' | 'ready'

function StepProgress({ current, total }: { current: number; total: number }) {
  const pct = Math.round((current / total) * 100)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-zinc-500">
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

export function CalibrationScreen({ eye, onCalibrated, onBack, skipReactionTime, testMode, speedMode = 'normal' }: Props) {
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
  const initialStep: Step = !savedScreenCal
    ? 'screen'
    : savedScreenCal.viewingDistanceCm == null
      ? 'distance'
      : savedScreenCal.brightnessFloor == null
        ? 'brightness'
        : !wantsReactionTime
          ? 'ready'
          : 'reaction'
  const [step, setStep] = useState<Step>(initialStep)
  // screen (card) + distance + brightness + (reaction?) + ready.
  // Blindspot position verification happens in the test component itself
  // (as the `position-check` phase) right before the countdown fires, so
  // the patient doesn't have to re-settle between "confirm distance" and
  // "sit for the test". See components/PositionCheckOverlay.tsx.
  const totalSteps = wantsReactionTime ? 5 : 4
  const stepNumber =
    step === 'screen' ? 1 :
    step === 'distance' ? 2 :
    step === 'brightness' ? 3 :
    step === 'reaction' ? 4 :
    totalSteps

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

  const cardHeightPx = cardWidthPx * (CREDIT_CARD_HEIGHT_MM / CREDIT_CARD_WIDTH_MM)
  const pxPerMm = cardWidthPx / CREDIT_CARD_WIDTH_MM
  const pxPerDeg = pxPerMm * (distanceCm * 10) * Math.tan(Math.PI / 180)

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
    setStep('distance')
  }
  const handleRecalibrateScreen = () => {
    // Drop the active selection — the bank-card step will then run
    // from scratch and re-create / re-stamp the workstation entry.
    clearActiveScreen()
    setSavedScreenCal(null)
    setStep('screen')
  }
  const handleDistanceDone = () => setStep('brightness')

  const handleBrightnessDone = () => {
    setBrightnessFloor(brightness)
    if (!wantsReactionTime) {
      // Skip reaction time — go straight to ready with a default value
      setStep('ready')
      return
    }
    setStep('reaction')
    setRtStarted(false)
    setRtTimes([])
    setRtCurrent(0)
    setRtPhase('waiting')
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
    onCalibrated({
      pixelsPerDegree: pxPerDeg,
      maxEccentricityDeg: Math.floor(maxEcc),
      viewingDistanceCm: distanceCm,
      brightnessFloor,
      reactionTimeMs: medianRt,
      fixationOffsetPx,
      screenWidthPx: effectiveTestDims(isMobile).width,
      screenHeightPx: effectiveTestDims(isMobile).height,
      sphericityCorrection: true,
    }, extendedField)
  }

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
      <div className="min-h-[100dvh] bg-base text-white safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
        <main className="max-w-lg w-full space-y-8">
          <BackButton onClick={onBack} />
          <StepProgress current={stepNumber} total={totalSteps} />

          <h1 className="text-2xl font-heading font-bold">Screen calibration</h1>

          {isMobile && (
            <div className="bg-red-900/20 border border-red-700/40 rounded-xl px-4 py-3 text-sm space-y-1">
              <p className="text-red-400 font-medium">Mobile device detected</p>
              <p className="text-red-400/70 text-xs">
                This test requires a large screen to cover enough visual field.
                On a phone you can only test the central ~{Math.floor(Math.min(fieldUp, fieldLeft, fieldRight))}°.
                Use a laptop, desktop monitor, or tablet for meaningful results.
              </p>
            </div>
          )}

          {isSmallWindow && (
            <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl px-4 py-3 text-sm space-y-1">
              <p className="text-yellow-400 font-medium">Maximize your browser window</p>
              <p className="text-yellow-400/70 text-xs">
                Your browser window is small — maximize it or go fullscreen (F11) to cover more visual field.
                Current coverage is only ~{Math.floor(Math.min(fieldUp, fieldLeft, fieldRight))}° from center. For RP monitoring, 30°+ is ideal.
              </p>
            </div>
          )}

          <div className="space-y-3">
            <p className="text-sm text-zinc-300">
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
      <div className="min-h-[100dvh] bg-base text-white safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
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
                <p className="text-zinc-100 font-medium">Turn your phone sideways</p>
                <p className="text-zinc-400 text-xs mt-0.5">Landscape gives you a wider field to test.</p>
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
            <p className="text-sm text-zinc-300">
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
                <div className="text-[11px] text-zinc-500 flex items-center gap-2">
                  <span>
                    Suggested: <span className="text-zinc-300 font-mono">{suggested} cm</span>{' '}
                    <span className="text-zinc-600">
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
            const fTemporal = eye === 'right'
              ? Math.floor((fullW - fullFixX) / pxPerDeg)
              : Math.floor(fullFixX / pxPerDeg)
            const fNasal = eye === 'right'
              ? Math.floor(fullFixX / pxPerDeg)
              : Math.floor((fullW - fullFixX) / pxPerDeg)
            // Extended-field mode (Goldmann only) runs two extra passes
            // with fixation shifted ±30% of fullHeight, so achievable
            // vertical reach becomes halfH + 0.3·fullH. Horizontal reach
            // is unchanged because we only shift the fixation dot
            // vertically between passes. Reflect the achievable number
            // here so the T·N·S·I readout matches what the test will
            // actually probe.
            const verticalReachPx = testMode === 'goldmann' && extendedField
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

            // Screen testable polygon (+ extended variants)
            const screenPoly = (fyOffset: number) => Array.from({ length: 36 }, (_, i) => {
              const angleDeg = i * 10
              const rad = (angleDeg * Math.PI) / 180
              const dx = Math.cos(rad)
              const dy = -Math.sin(rad)
              const halfW = fullW / 2
              const halfH = fullH / 2
              const fx = fixationOffsetPx
              let t = 9999
              if (dx > 0.001) t = Math.min(t, (halfW - fx) / dx)
              if (dx < -0.001) t = Math.min(t, (-halfW - fx) / dx)
              if (dy > 0.001) t = Math.min(t, (halfH - fyOffset) / dy)
              if (dy < -0.001) t = Math.min(t, (-halfH - fyOffset) / dy)
              const eccDeg = t / pxPerDeg
              const r = Math.min(eccDeg * dScale, 135)
              return { deg: eccDeg, pt: `${150 + r * Math.cos(rad)},${150 - r * Math.sin(rad)}` }
            })
            const normalPoly = screenPoly(0)
            const normalPts = normalPoly.map(p => p.pt).join(' ')

            // Extended union
            const upShift = -fullH * 0.3
            const downShift = fullH * 0.3
            const upPoly = screenPoly(upShift)
            const downPoly = screenPoly(downShift)
            const extPts = Array.from({ length: 36 }, (_, i) => {
              const maxDeg = Math.max(normalPoly[i].deg, upPoly[i].deg, downPoly[i].deg)
              const r = Math.min(maxDeg * dScale, 135)
              const rad = (i * 10 * Math.PI) / 180
              return `${150 + r * Math.cos(rad)},${150 - r * Math.sin(rad)}`
            }).join(' ')

            return (
              <div className="bg-surface/60 rounded-2xl border border-white/[0.06] p-4 text-center space-y-3">
                <p className="text-xs text-zinc-500 font-medium">Field coverage</p>
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
                <div className="flex gap-3 justify-center flex-wrap text-xs text-zinc-500">
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
                <p className="text-xs text-zinc-500">
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
                        : 'bg-surface border-white/[0.06] hover:border-white/[0.12]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-xs text-zinc-300">Extended field mode</p>
                        <p className="text-xs text-zinc-500 mt-0.5">
                          2 extra passes with shifted fixation for more vertical coverage (~2 min extra)
                        </p>
                      </div>
                      <div className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors flex-shrink-0 ml-2 ${
                        extendedField ? 'bg-green-600 justify-end' : 'bg-zinc-700 justify-start'
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
              <p className="text-xs text-zinc-500 leading-relaxed">
                <span className="text-zinc-400">Heads-up:</span> your screen
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
      <div className="min-h-[100dvh] bg-base text-white safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
        <main className="max-w-lg w-full space-y-8">
          <BackButton onClick={() => setStep('distance')} />

          <StepProgress current={stepNumber} total={totalSteps} />
          <h1 className="text-2xl font-heading font-bold">Find your dimmest visible dot</h1>

          <div className="space-y-2 text-sm text-zinc-300">
            <p>We need to know the dimmest dot your screen can show.</p>
            <ol className="list-decimal list-inside space-y-1 text-zinc-400">
              <li>Start high — drag the slider right until you clearly see the white dot.</li>
              <li>Slowly drag left. Stop the moment the dot disappears.</li>
              <li>Nudge back right by one step so the dot is just barely visible again.</li>
            </ol>
          </div>

          <div className="relative w-full h-48 bg-base rounded-xl border border-white/[0.06] flex items-center justify-center">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: `rgba(255, 255, 255, ${brightness})` }}
            />
            <span className="absolute top-2 right-3 text-xs text-zinc-500 font-mono">
              {(brightness * 100).toFixed(1)}%
            </span>
          </div>

          <input
            type="range"
            min={0.5}
            max={50}
            step={0.5}
            value={brightness * 100}
            onChange={e => setBrightness(Number(e.target.value) / 100)}
            aria-label={`Brightness level: ${(brightness * 100).toFixed(1)}%`}
            className="w-full accent-amber-500"
          />

          <div className="flex gap-2 text-xs text-zinc-500">
            <span>← dimmer (invisible)</span>
            <span className="flex-1" />
            <span>brighter (clearly visible) →</span>
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
        <div className="min-h-[100dvh] bg-base text-white safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
          <main className="max-w-lg w-full space-y-8">
            <BackButton onClick={() => { setRtTimes([]); setRtPhase('waiting'); setRtStarted(false); setStep('brightness') }} />
            <StepProgress current={stepNumber} total={totalSteps} />
            <h1 className="text-2xl font-heading font-bold">Reaction time measured</h1>

            <div className="bg-surface rounded-2xl border border-white/[0.06] p-5 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Your median RT</span>
                <span className="font-mono text-white">{medianRt.toFixed(0)} ms</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Position compensation</span>
                <span className="font-mono text-white">
                  +{((3 * medianRt) / 1000).toFixed(1)}° per reading
                </span>
              </div>
              <p className="text-xs text-zinc-500">
                At 3°/s stimulus speed, your reaction time shifts each recorded position by{' '}
                {((3 * medianRt) / 1000).toFixed(1)}°. This is automatically corrected.
              </p>
            </div>

            <div className="text-xs text-zinc-500">
              Individual times: {rtTimes.map(t => `${t.toFixed(0)}ms`).join(', ')}
            </div>

            <div className="action-footer">
              <button
                onClick={() => setStep('ready')}
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
        <div className="min-h-[100dvh] bg-base text-white safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
          <main className="max-w-lg w-full space-y-8">
            <BackButton onClick={() => setStep('brightness')} />

            <StepProgress current={stepNumber} total={totalSteps} />
            <h1 className="text-2xl font-heading font-bold">Reaction time test</h1>

            <div className="space-y-3 text-sm text-zinc-300">
              <p>
                We'll measure your reaction time with {RT_TRIALS} quick trials.
              </p>
              <div className="bg-surface rounded-2xl border border-white/[0.06] p-4 space-y-2">
                <p>1. Stare at the center of the screen</p>
                <p>2. A white dot will appear after a random delay</p>
                <p>3. <strong className="text-white">{isMobile ? 'Tap the screen' : 'Tap the screen or press Space'}</strong> as fast as you can when you see it</p>
              </div>
              <p className="text-zinc-500 text-xs">
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
          <p className="text-xs text-zinc-500">Step 3 of 3 — Reaction time</p>
          <p className="text-zinc-400 text-sm max-w-xs mx-auto" aria-live="assertive">
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

          <p className="text-zinc-500 text-xs">
            Trial {rtCurrent + 1} of {RT_TRIALS}
          </p>
        </main>
      </div>
    )
  }

  // ==================== STEP 5: Ready ====================
  return (
    <div className="min-h-[100dvh] bg-base text-white safe-pad flex flex-col items-center px-6 pt-10 pb-10 animate-page-in">
      <main className="max-w-lg w-full space-y-8">
        <BackButton onClick={() => setStep(wantsReactionTime ? 'reaction' : 'brightness')} />

        <h1 className="text-2xl font-heading font-bold">Ready to test</h1>

        <div className="bg-surface rounded-2xl border border-white/[0.06] p-5 space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-400">Test type</span>
            <span>{testMode === 'static' ? 'Static test' : 'Goldmann (kinetic)'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">Eye</span>
            <span>{eye === 'right' ? 'OD (Right)' : 'OS (Left)'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">Field coverage</span>
            <span>T {fieldTemporal}° · N {fieldNasal}° · S {fieldUp}° · I {fieldDown}°</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">Brightness floor</span>
            <span className="font-mono">{(brightnessFloor * 100).toFixed(1)}%</span>
          </div>
          {wantsReactionTime && (
            <div className="flex justify-between">
              <span className="text-zinc-400">Reaction time</span>
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
                    <span className="text-zinc-400">Mode</span>
                    <span>Quick scan (central 10°)</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-zinc-400">Grid</span>
                  <span>{info.label} — {points} points</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Stimuli</span>
                  <span>Goldmann III, 0–35 dB</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Staircase</span>
                  <span>4-2 dB adaptive</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Pacing</span>
                  <span>Timed flashes — tap when seen</span>
                </div>
              </>
            )
          })() : speedMode === 'quick' ? (
            <>
              <div className="flex justify-between">
                <span className="text-zinc-400">Mode</span>
                <span>Quick scan (single isopter)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Stimulus</span>
                <span>III4e only — 12 meridians</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Adaptive</span>
                <span>Outlier retest only</span>
              </div>
            </>
          ) : (
            <>
              <div className="flex justify-between">
                <span className="text-zinc-400">Stimuli</span>
                <span>V4e, III4e, III2e, I4e, I2e</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Adaptive</span>
                <span>Yes — problem areas retested</span>
              </div>
            </>
          )}
        </div>

        {/* Test instructions */}
        <div className="bg-surface/60 border border-white/[0.06] rounded-2xl px-4 py-3 space-y-2 text-xs text-zinc-400">
          <p className="text-sm text-zinc-300 font-medium mb-2">
            Testing <span className="text-white">{formatEyeLabelLong(eye)}</span>
          </p>
          <div className="flex gap-2 items-start">
            <span className="text-yellow-500 mt-0.5">&#9790;</span>
            <p><span className="text-zinc-300 font-medium">Dark room.</span> Perform the test in a dark or dimly lit room for best contrast, just like clinical perimetry.</p>
          </div>
          <div className="flex gap-2 items-start">
            <span className="text-green-400 mt-0.5">&#9673;</span>
            <p><span className="text-zinc-300 font-medium">Fixation.</span> Keep your eye fixed on the yellow dot during the test. Only press when you see a stimulus in your peripheral vision.</p>
          </div>
          {!isMobile && (
            <div className="flex gap-2 items-start">
              <span className="text-zinc-500 mt-0.5">&#9099;</span>
              <p>
                <span className="text-zinc-300 font-medium">Pause or leave.</span> Press{' '}
                <kbd className="px-1.5 py-0.5 bg-zinc-800 border border-white/[0.06] rounded text-[10px] font-mono text-zinc-300">Esc</kbd>{' '}
                any time to pause the test or exit.
              </p>
            </div>
          )}
        </div>

        {/* Duration estimates are advertised on the home screen next to
            the speed toggle — no need to repeat them here and risk the
            two surfaces drifting out of sync. */}
        <p className="text-xs text-zinc-500">
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
