import { useCallback, useEffect, useRef } from 'react'
import type { PresentationMode } from '../types'
import { useRemoteInput, useCountdownAdvance, REMOTE_RESPONSE_KEYS } from '../remoteInput'

interface Props {
  presentationMode: PresentationMode
  /** Advance to the left-eye test. */
  onContinue: () => void
  /** Abandon the left eye and show right-eye-only results. */
  onSkip: () => void
}

// How long the in-headset switch screen waits before starting the left eye
// on its own. Generous enough to rest between eyes; a remote press skips it.
const VR_SWITCH_SECONDS = 15

/**
 * The "right eye done → left eye next" interstitial.
 *
 * Standard mode keeps the familiar instructions (cover the right eye, align
 * the nose) with tap buttons. Phone-VR can't use those: the phone is sealed in
 * the headset, so the patient would have to pull it out just to tap "start".
 * Instead the VR variant is fully hands-free — the lens switch handles the eye
 * change optically (no repositioning), and the screen advances on a remote
 * press or, failing that, a visible countdown. The phone never comes out.
 */
export function BinocularSwitch({ presentationMode, onContinue, onSkip }: Props) {
  const isVr = presentationMode === 'phone-vr'

  const beepRef = useRef<() => void>(() => {})
  const advance = useCallback(() => {
    beepRef.current()
    onContinue()
  }, [onContinue])
  const remote = useRemoteInput(advance)
  useEffect(() => {
    beepRef.current = remote.beep
  }, [remote.beep])

  // Re-arm on mount: the previous test's remote hook unmounted with it, so
  // its media/gamepad capture is gone. There's no user gesture here (that's
  // the whole point), but gamepad polling needs none, so controller buttons
  // still register; the countdown covers remotes that don't.
  useEffect(() => {
    if (isVr) remote.arm()
  }, [isVr, remote])

  // Keyboard-style remotes (Enter / volume / arrows) — useRemoteInput leaves
  // these to the caller.
  useEffect(() => {
    if (!isVr) return
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === 'Enter' ||
        e.key === ' ' ||
        e.code === 'Space' ||
        e.code === 'NumpadEnter' ||
        REMOTE_RESPONSE_KEYS.has(e.key)
      ) {
        e.preventDefault()
        advance()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isVr, advance])

  const countdown = useCountdownAdvance(isVr, VR_SWITCH_SECONDS, 'switch', advance)

  if (isVr) {
    return (
      <div
        className="fixed inset-0 bg-black text-white select-none cursor-pointer"
        role="application"
        aria-label="Right eye done — keep the headset on; the left eye test starts automatically, or press your remote button to start now"
        onPointerDown={advance}
      >
        {/* Duplicated into both lens halves so the message is legible
            whichever eye the patient looks through during the switch. */}
        {[0.25, 0.75].map(frac => (
          <div
            key={frac}
            className="absolute text-center px-4"
            style={{ left: `${frac * 100}%`, top: '50%', transform: 'translate(-50%, -50%)', width: '42%' }}
          >
            <h1 className="text-base font-heading font-bold">Right eye done</h1>
            <p className="mt-1 text-[11px] text-zinc-400 leading-snug">
              Keep the headset on and rest a moment — your left eye is next.
            </p>
            <p className="mt-3 text-[11px] text-accent leading-snug">
              Press the button for the left eye
              {countdown != null && (
                <span className="block text-zinc-500">or starting automatically in {countdown}s</span>
              )}
            </p>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="min-h-[100dvh] bg-base text-body flex items-center justify-center p-6 safe-pad">
      <main className="max-w-sm w-full space-y-8 text-center animate-page-in">
        <div className="w-20 h-20 mx-auto rounded-full bg-teal-tint flex items-center justify-center border border-teal/30">
          <svg viewBox="0 0 24 24" className="w-10 h-10 text-teal" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-heading font-bold">Right eye done!</h1>
          <p className="text-muted">
            Now switch to your <span className="text-ink font-semibold">left eye (<abbr title="Oculus Sinister">OS</abbr>)</span>.
          </p>
        </div>

        <div className="card p-5 space-y-3 text-sm text-left">
          <div className="flex gap-3 items-start">
            <span className="text-accent font-heading font-bold mt-0.5">1.</span>
            <p className="text-body">Cover your <strong className="text-ink">right</strong> eye</p>
          </div>
          <div className="flex gap-3 items-start">
            <span className="text-accent font-heading font-bold mt-0.5">2.</span>
            <p className="text-body">Position yourself so your nose aligns with the <strong className="text-ink">right edge</strong> of the screen</p>
          </div>
          <div className="flex gap-3 items-start">
            <span className="text-accent font-heading font-bold mt-0.5">3.</span>
            <p className="text-body">Take a moment to rest if needed</p>
          </div>
        </div>

        <button
          onClick={onContinue}
          className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
        >
          Start left eye test
        </button>

        <button
          onClick={onSkip}
          className="text-muted hover:text-ink text-sm transition-colors min-h-[44px] px-3"
        >
          Skip — show right eye results only
        </button>
      </main>
    </div>
  )
}
