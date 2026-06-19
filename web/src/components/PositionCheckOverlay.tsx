// PositionCheckOverlay — fullscreen pre-flight blindspot verification
// shown after the user taps "Start" / "Ready" on a test, before the
// countdown begins. Confirms the patient is positioned close enough to
// the configured viewing distance that the anatomical blindspot (~15°
// temporal, 1.5° below horizontal) actually falls on their blindspot and
// not somewhere they can see.
//
// Clinical note: this is a gross-error sanity check. The real
// fixation-loss monitoring happens via Heijl-Krakau catch trials DURING
// the test (see GoldmannTest.presentCatchTrial). The pre-flight exists
// to catch "user entered the wrong distance" and "user is not looking
// at the screen" before any measurement is taken, not to replace
// in-test monitoring.
//
// Placement: the overlay is shown by each test component (Goldmann,
// Static) as a short-lived phase immediately after the user dismisses
// the instructions/HeadGuide screen. This is intentional — the patient
// has just read "cover your {other} eye and sit at {distance} cm," so
// they're already positioned; the check runs in-place instead of mid-
// calibration where the user would have to re-settle before starting.

import { useEffect, useRef, useState } from 'react'
import type { CalibrationData, StoredEye } from '../types'
import { blindspotLocation } from '../blindspot'
import { degToPx } from '../geometry'
import { HeadGuide } from './HeadGuide'

interface Props {
  eye: StoredEye
  calibration: CalibrationData
  onPass: () => void
  /**
   * Skip the initial "Get in position" HeadGuide screen and drop straight
   * into the blindspot check. Static passes this because its instructions
   * phase already shows a HeadGuide — rendering another one here would
   * feel redundant. Goldmann (no instructions phase) leaves it off so the
   * patient still sees the profile sketch + distance callout first.
   */
  skipPrepare?: boolean
  /**
   * Whether to run the blindspot dot check after the prepare screen.
   * When false, the prepare screen's "I'm ready" button fires `onPass`
   * directly — used when the patient only needs the positioning guide
   * (default behaviour on Goldmann) without sitting through the
   * blindspot check. Defaults to `true` so callers that don't think
   * about it get the original two-step flow.
   */
  runBlindspotCheck?: boolean
  /** Posture variant for the embedded HeadGuide. */
  headGuideMode?: 'desktop' | 'phone'
}

/**
 * Fullscreen overlay that renders the fixation dot + a V4e-sized
 * stimulus at the anatomical blindspot, and asks the patient to confirm
 * they only see the yellow dot.
 *
 *  - "No, only the yellow dot"  → onPass() (proceed into countdown)
 *  - "Yes, I see two dots"      → show adjust-distance guidance + retry
 *  - Tunnel-vision disclosure   → onPass() (see clinical note below)
 *
 * Tunnel-vision disclosure: for patients whose remaining field is
 * narrower than ~15° (advanced RP / glaucoma), the blindspot stimulus
 * AND everything around it fall in the lost field regardless of
 * positioning. "I only see the yellow dot" in that case is not
 * evidence of correct positioning — it just reflects disease. We surface
 * the limitation and let those patients skip, trusting the viewing-
 * distance entry from calibration instead.
 */
export function PositionCheckOverlay({
  eye,
  calibration,
  onPass,
  skipPrepare = false,
  runBlindspotCheck = true,
  headGuideMode = 'desktop',
}: Props) {
  // Two-step flow: first show the HeadGuide illustration so the patient
  // has a visual reference for "how to sit", then run the actual blindspot
  // check. Keeps the profile sketch that used to live in the pre-fd4596e
  // calibration blindspot step. Callers that already showed a HeadGuide
  // just before (Static's instructions phase) pass skipPrepare=true.
  // Phone-in-headset: the headset optics fix the viewing geometry and the
  // dark lens half already occludes the untested eye, so the "sit X cm
  // away / cover your other eye" guidance and the blindspot distance check
  // don't apply. Show headset-specific setup copy and skip the check.
  const isVr = !!calibration.vr?.enabled
  const blindspotEnabled = runBlindspotCheck && !isVr
  const [step, setStep] = useState<'prepare' | 'check'>(
    skipPrepare && !isVr ? 'check' : 'prepare',
  )
  const [result, setResult] = useState<'ok' | 'saw' | null>(null)
  const coveredEyeTop = eye === 'right' ? 'left' : 'right'

  // Phone-in-headset: the prepare screen ("Get into the headset" / "I'm
  // ready") is centered full-screen, so through the lenses it splits across
  // the nose bridge and is illegible, and its tap target is unreachable with
  // the phone sealed in the headset. The blindspot check is also disabled in
  // VR, and calibration already showed a single-eye "Ready to test" confirm
  // immediately before — so the overlay has nothing to present here. Skip
  // straight to the caller's next phase (the VR-aware countdown). A black
  // frame covers the one render before onPass unmounts us.
  const passedRef = useRef(false)
  useEffect(() => {
    if (isVr && !passedRef.current) {
      passedRef.current = true
      onPass()
    }
  }, [isVr, onPass])
  if (isVr) {
    return <div className="fixed inset-0 bg-black z-50" aria-hidden="true" />
  }

  if (step === 'prepare') {
    return (
      <div
        className="fixed inset-0 bg-black z-50 flex items-center justify-center cursor-default text-white"
        role="dialog"
        aria-modal="true"
        aria-label={isVr ? 'Get into the headset' : 'Position your head'}
      >
        <div className="max-w-sm w-full px-6 text-center space-y-6">
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">
              {isVr ? 'Get into the headset' : 'Get in position'}
            </h2>
            <p className="text-sm text-zinc-300">
              {isVr ? (
                <>
                  Seat the phone in the headset cradle, then put the headset
                  on. Keep your head still and look straight ahead at the{' '}
                  <span className="text-white font-semibold">yellow dot</span>{' '}
                  through the lens.
                </>
              ) : headGuideMode === 'phone' ? (
                <>
                  Hold the phone{' '}
                  <span className="text-white font-mono">{calibration.viewingDistanceCm} cm</span>{' '}
                  from your eye with both hands and cover your{' '}
                  <span className="text-white font-semibold">{coveredEyeTop}</span> eye.
                </>
              ) : (
                <>
                  Sit <span className="text-white font-mono">{calibration.viewingDistanceCm} cm</span>{' '}
                  from the screen and cover your{' '}
                  <span className="text-white font-semibold">{coveredEyeTop}</span> eye.
                </>
              )}
            </p>
          </div>

          {!isVr && (
            <div className="flex justify-center">
              <HeadGuide eye={eye} viewingDistanceCm={calibration.viewingDistanceCm} compact mode={headGuideMode} />
            </div>
          )}

          {blindspotEnabled && (
            <p className="text-xs text-zinc-500">
              Next we&apos;ll run a quick blindspot check to confirm your distance
              is correct.
            </p>
          )}

          <button
            onClick={() => blindspotEnabled ? setStep('check') : onPass()}
            className="w-full py-3 btn-primary rounded-xl text-base font-medium text-white"
          >
            I&apos;m ready
          </button>
        </div>
      </div>
    )
  }

  // Anatomical blindspot in screen coordinates for the tested eye.
  const bs = blindspotLocation(eye)
  const bsRad = (bs.meridianDeg * Math.PI) / 180
  const bsXDeg = bs.eccentricityDeg * Math.cos(bsRad)
  const bsYDeg = bs.eccentricityDeg * Math.sin(bsRad)
  const bsXPx = degToPx(bsXDeg, calibration)
  const bsYPx = -degToPx(bsYDeg, calibration) // screen Y grows downward

  // V4e stimulus size in pixels — matches the real catch trial.
  const stimDiamDeg = 1.73
  const stimDiamPx = Math.max(
    4,
    Math.round(degToPx(stimDiamDeg, calibration)),
  )

  const fixationOffsetPx = eye === 'right'
    ? calibration.fixationOffsetPx
    : -calibration.fixationOffsetPx
  const coveredEye = eye === 'right' ? 'left' : 'right'

  return (
    <div
      className="fixed inset-0 bg-black z-50 cursor-default"
      role="dialog"
      aria-modal="true"
      aria-label="Blindspot position check"
    >
      {/* Fixation dot — same size and position as the real test. */}
      <div
        className="absolute w-3 h-3 rounded-full bg-yellow-400"
        style={{
          top: '50%',
          left: '50%',
          marginLeft: -6 + fixationOffsetPx,
          marginTop: -6,
        }}
      />

      {/* Blindspot stimulus — full-brightness white V4e-sized dot. */}
      <div
        className="absolute rounded-full bg-white"
        style={{
          top: '50%',
          left: '50%',
          width: stimDiamPx,
          height: stimDiamPx,
          marginLeft: -stimDiamPx / 2 + fixationOffsetPx + bsXPx,
          marginTop: -stimDiamPx / 2 + bsYPx,
        }}
      />

      {/* Prompt lives close to fixation (≈40 px ≈ 1.5° below the yellow
          dot at typical viewing) so the patient can read it without
          breaking fixation. Mirrors the fixation offset so it tracks
          the dot on wide layouts. */}
      <div
        className="absolute text-white text-center space-y-3 px-4"
        style={{
          top: '50%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginLeft: fixationOffsetPx,
          marginTop: 40,
          maxWidth: 420,
        }}
      >
        <p className="text-sm text-zinc-200">
          Cover your <span className="text-white font-semibold">{coveredEye}</span> eye
          and keep looking at the yellow dot. Do you see any other dot?
        </p>
        <p className="text-xs text-zinc-500">
          Configured distance:{' '}
          <span className="text-zinc-300 font-mono">
            {calibration.viewingDistanceCm} cm
          </span>
          . If you see two dots, this is likely off.
        </p>

        <div className="flex items-center justify-center gap-2 flex-wrap">
          <button
            onClick={onPass}
            className="px-4 py-2 btn-primary rounded-lg text-sm font-medium text-white"
          >
            No — only the yellow dot
          </button>
          <button
            onClick={() => setResult('saw')}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm font-medium text-white"
          >
            Yes — I see two dots
          </button>
        </div>

        {result === 'saw' && (
          <div className="bg-orange-900/25 border border-orange-700/50 rounded-xl px-4 py-3 text-xs text-orange-200 space-y-1 text-left">
            <p className="font-medium">Try adjusting your distance.</p>
            <p className="text-orange-200/80">
              Move ~5 cm closer or further away, keep your head still, and
              look back at the yellow dot. Then pick one of the two answers
              above based on what you now see.
            </p>
          </div>
        )}

        {/* Tunnel-vision escape hatch. For patients whose remaining field
            is narrower than the blindspot eccentricity, this check is
            uninformative by construction — let them identify themselves
            and skip with an honest explanation. */}
        <details className="text-xs text-zinc-500 text-left">
          <summary className="cursor-pointer hover:text-zinc-300 select-none">
            My remaining field is very small (tunnel vision)
          </summary>
          <div className="mt-2 pl-3 border-l border-white/10 space-y-2 text-zinc-400">
            <p>
              If your usable field is narrower than about 15° from center,
              the blindspot check can't verify positioning — the blindspot
              stimulus and everything around it falls outside what you can
              see regardless of how you sit. A passed check in that case is
              not informative.
            </p>
            <p>
              Rely on the viewing distance you entered and continue. Sit at
              exactly that distance, since the test can't cross-check it
              for you.
            </p>
            <button
              onClick={onPass}
              className="text-accent hover:text-accent-light underline decoration-dotted"
            >
              Skip &amp; start test
            </button>
          </div>
        </details>
      </div>
    </div>
  )
}
