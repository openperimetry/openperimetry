// Bluetooth "VR remote" / controller capture + press feedback.
//
// The clickers and controllers that ship with passive phone-VR headsets reach
// the browser through several different transports depending on the device and
// its pairing mode, and none of them is the plain keydown the test originally
// listened for. The VR Shinecon SC-803 is the worked example, and on iOS it
// pins down why every transport below is needed:
//
//   1. Media mode — in the remote's default "VR" / Android mode the confirm
//      button (and the rocker) emit transport keys: the trigger sends
//      Play/Pause, the rocker sends prev/next track. The OS routes these to
//      whoever owns the media session, so the page never sees them as
//      keydowns and the button just pauses the user's music. We claim the
//      session by playing a silent looping <audio> element and registering
//      `navigator.mediaSession` action handlers. On iOS Safari this is the
//      ONLY way a web page can receive that button: the SC-803 exposes no
//      Gamepad API there (iOS doesn't surface it), and its "mouse mode"
//      confirm maps to a hardware volume command iOS swallows (it cranks
//      system volume instead of reaching the page).
//
//   2. Gamepad mode — in the remote's gaming mode (and fuller controllers with
//      A/B/X/Y, a trigger, and a clickable thumbstick) button presses arrive
//      through the Gamepad API instead. We poll the connected pads each frame
//      while armed and fire on the rising edge of any button. Thumbstick
//      *steering* (analog axes) is deliberately ignored so stick drift can't
//      register phantom "seen" responses — only discrete button presses count.
//      (Gaming mode is unavailable on iOS but works on Android.)
//
//   3. Keyboard mode — HID-keyboard-style remotes send real keys. Callers
//      handle those in their own keydown listeners using `REMOTE_RESPONSE_KEYS`.
//
// Because autoplay and AudioContext start are gated behind a user gesture, both
// the silent keep-alive audio and the feedback beep can only be armed from a
// real interaction (the test-start tap). The hook therefore returns an `arm()`
// to call from that gesture, plus a `beep()` for press confirmation — a short
// tone so a patient inside a headset, with no visible button feedback, hears
// that their press registered, like the click of a real perimeter clicker.

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * `KeyboardEvent.key` values emitted by HID-keyboard-style remotes that should
 * count as a response press, in addition to Space/Enter which callers already
 * handle. Volume and media keys are included because many clickers map their
 * single button to one of these (on Android these can arrive as real keydowns;
 * iOS routes media keys to the MediaSession path above instead). Arrow /
 * PageUp / PageDown cover presenter-style remotes.
 */
export const REMOTE_RESPONSE_KEYS = new Set<string>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'AudioVolumeUp',
  'AudioVolumeDown',
  'MediaPlayPause',
  'MediaPlay',
  'MediaPause',
  'MediaTrackNext',
  'MediaTrackPrevious',
])

// Thumbstick tilt magnitude (per axis) that counts as a deliberate "steer".
// Well above typical resting drift (<0.3) so an idle stick never trips it; a
// tilt past this in any direction fires one press and re-arms after the stick
// returns inside the deadzone.
const AXIS_PRESS_THRESHOLD = 0.7
const AXIS_RELEASE_THRESHOLD = 0.35

// MediaSession actions that a single-button remote might fire. We map all of
// them to the same response callback, so it doesn't matter whether the OS
// thinks the transport is currently playing (→ 'pause') or paused (→ 'play'),
// and so the rocker's prev/next-track presses also count as a response.
const MEDIA_ACTIONS: MediaSessionAction[] = [
  'play',
  'pause',
  'stop',
  'nexttrack',
  'previoustrack',
  'seekforward',
  'seekbackward',
]

// Build a tiny silent looping WAV as an object URL. Constructed at runtime so
// we don't ship a multi-KB base64 blob in the bundle. 8 kHz mono 16-bit, 1 s.
function makeSilentWavUrl(): string {
  const sampleRate = 8000
  const numSamples = sampleRate // 1 second
  const bytesPerSample = 2
  const dataSize = numSamples * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // format = PCM
  view.setUint16(22, 1, true) // channels = mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  // sample bytes are already zero → silence
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

// ---- Shared silent keep-alive (module singleton) ----
// Owning the media session requires audio to be actively PLAYING. If each
// useRemoteInput instance owned and paused its own <audio>, the session would
// be released whenever one screen unmounts before the next mounts (the
// calibration → test handoff) — and on iOS a freshly-created element can't
// reliably re-acquire the session without a new user gesture, so the remote's
// button reverts to controlling the user's music (e.g. Spotify resumes).
// Instead ONE shared element, started once from a real gesture, keeps PLAYING
// across mounts. Release is debounced so a same-tick unmount→remount handoff
// cancels it and never drops the session; a true teardown (no remount) lets it
// fire and frees the user's media.
let keepAlive: HTMLAudioElement | null = null
let keepAliveUrl: string | null = null
let keepAliveReleaseTimer: ReturnType<typeof setTimeout> | null = null

function cancelKeepAliveRelease(): void {
  if (keepAliveReleaseTimer != null) {
    clearTimeout(keepAliveReleaseTimer)
    keepAliveReleaseTimer = null
  }
}

/** Ensure the shared keep-alive is playing (creating it once). Cancels any
 *  pending release. Must first be called from a user gesture for the play to
 *  be allowed; later calls on the already-playing element are no-ops. */
function playKeepAlive(): void {
  if (typeof Audio === 'undefined') return
  cancelKeepAliveRelease()
  if (!keepAlive) {
    keepAliveUrl = makeSilentWavUrl()
    keepAlive = new Audio(keepAliveUrl)
    keepAlive.loop = true
    keepAlive.volume = 0
  }
  keepAlive.play().catch(() => {
    /* gesture/autoplay rejected — other transports still work */
  })
}

function setMediaPlaying(playing: boolean): void {
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'none'
    } catch {
      /* ignore */
    }
  }
}

/** Stop the keep-alive and release the session immediately (used by disarm). */
function releaseKeepAliveNow(): void {
  cancelKeepAliveRelease()
  keepAlive?.pause()
  setMediaPlaying(false)
}

/** Schedule a release shortly in the future; a handoff's playKeepAlive cancels
 *  it before it fires, so the session survives screen transitions. */
function requestKeepAliveRelease(): void {
  if (keepAliveReleaseTimer != null) return
  keepAliveReleaseTimer = setTimeout(() => {
    keepAliveReleaseTimer = null
    keepAlive?.pause()
    setMediaPlaying(false)
  }, 600)
}

interface Beeper {
  /** Create/resume the AudioContext from within a user gesture. */
  resume: () => void
  /** Play a short confirmation tone. No-op if audio is unavailable. */
  beep: () => void
  /** Release the AudioContext. */
  close: () => void
}

// Web Audio press-confirmation tone. Created lazily; the context must be
// resumed inside a user gesture (see `arm`) or iOS keeps it suspended.
function makeBeeper(): Beeper {
  let ctx: AudioContext | null = null
  const ensure = (): AudioContext | null => {
    if (typeof window === 'undefined') return null
    if (!ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      if (AC) ctx = new AC()
    }
    return ctx
  }
  return {
    resume() {
      const c = ensure()
      if (c && c.state === 'suspended') c.resume().catch(() => {})
    },
    beep() {
      const c = ensure()
      if (!c) return
      if (c.state === 'suspended') c.resume().catch(() => {})
      const now = c.currentTime
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.type = 'sine'
      osc.frequency.value = 880
      // Quick attack/decay envelope — ~120 ms blip, exponential ramps avoid
      // the click an instant gain change would produce.
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
      osc.connect(gain)
      gain.connect(c.destination)
      osc.start(now)
      osc.stop(now + 0.13)
    },
    close() {
      if (ctx) {
        ctx.close().catch(() => {})
        ctx = null
      }
    },
  }
}

export interface RemoteInput {
  /**
   * Start the silent media keep-alive, claim the media session, begin gamepad
   * polling, and resume the beep AudioContext. Must be called from a user
   * gesture (the test-start / resume tap). Idempotent.
   */
  arm: () => void
  /** Play the press-confirmation tone. */
  beep: () => void
  /**
   * Release the capture (stop gamepad polling, pause the silent keep-alive,
   * clear MediaSession handlers + playback state) without unmounting. Call
   * when the test is over so the remote stops owning the media session on the
   * results screen. Idempotent.
   */
  disarm: () => void
}

/**
 * Wire a remote/controller's button to `onButton` across media, gamepad, and
 * keyboard transports (see file header), and provide an audible press-
 * confirmation `beep`. MediaSession handlers are registered on mount; the
 * silent keep-alive audio, gamepad polling, and AudioContext are started by
 * `arm` from a user gesture. All resources are released on unmount.
 */
export function useRemoteInput(
  onButton: () => void,
  options?: { axisAsPress?: boolean },
): RemoteInput {
  const cb = useRef(onButton)
  // Keep the latest callback without re-subscribing handlers; read at event
  // time, never during render.
  useEffect(() => {
    cb.current = onButton
  }, [onButton])
  // Whether thumbstick steering counts as a button press. On (default) for the
  // test, where any deliberate input means "I saw it". Off when the stick is
  // reserved for analog adjustment (see useThumbstickRamp) so a steer ramps a
  // value instead of firing a phantom press. Read at poll time via a ref so
  // `arm`'s empty-deps closure stays stable.
  const axisAsPressRef = useRef(options?.axisAsPress ?? true)
  useEffect(() => {
    axisAsPressRef.current = options?.axisAsPress ?? true
  }, [options?.axisAsPress])

  const beeperRef = useRef<Beeper | null>(null)
  // Gamepad polling: `rafRef` holds the live requestAnimationFrame id;
  // `prevButtonsRef` remembers each pad's last button states so we fire only on
  // a rising edge (press), never while a button is held down.
  const rafRef = useRef<number | null>(null)
  const prevButtonsRef = useRef<Map<number, boolean[]>>(new Map())
  // Per-pad "thumbstick currently tilted past threshold" flag, so a tilt fires
  // one press on the rising edge and re-arms only after the stick re-centers.
  const prevAxisRef = useRef<Map<number, boolean>>(new Map())
  // Per-pad resting axis values, captured on first sight. We measure tilt as
  // deviation from this baseline so an axis that rests away from 0 (a trigger
  // mapped to an axis often rests at -1) doesn't read as a permanent tilt.
  const axisBaselineRef = useRef<Map<number, number[]>>(new Map())

  // ---- MediaSession handlers + unmount teardown ----
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      const handler = () => {
        cb.current()
        // Re-own the session immediately. When the remote's Play/Pause button
        // fires, the OS toggles our silent keep-alive — iOS in particular
        // *pauses* it — which would stop the NEXT press from ever reaching this
        // handler (the button would just resume the user's music). Resuming the
        // shared keep-alive and reasserting `playbackState` keeps consecutive
        // presses landing here, so the confirm button works across every screen.
        playKeepAlive()
        setMediaPlaying(true)
      }
      for (const action of MEDIA_ACTIONS) {
        try {
          navigator.mediaSession.setActionHandler(action, handler)
        } catch {
          /* unsupported action on this browser — ignore */
        }
      }
    }
    return () => {
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        for (const action of MEDIA_ACTIONS) {
          try {
            navigator.mediaSession.setActionHandler(action, null)
          } catch {
            /* ignore */
          }
        }
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      // Don't stop the shared keep-alive outright — schedule a debounced
      // release so a handoff to the next screen's arm() keeps the session.
      // playbackState is left alone here for the same reason; the deferred
      // release clears it if nothing remounts.
      requestKeepAliveRelease()
      beeperRef.current?.close()
      beeperRef.current = null
    }
  }, [])

  const arm = useCallback(() => {
    // Start (or keep) the shared silent keep-alive playing → claim the media
    // session away from background apps so media-key remotes reach our handlers.
    // Must be reachable from a user gesture for the first play; later arms reuse
    // the already-playing shared element, which is what lets the session survive
    // the gesture-less calibration → test handoff.
    playKeepAlive()
    setMediaPlaying(true)
    // Start gamepad polling (idempotent — only one rAF loop at a time). The
    // loop fires `cb` on each button's rising edge; analog triggers count via
    // `value`, but axes (thumbstick steering) are never consulted so stick
    // drift can't register a phantom press.
    if (rafRef.current === null && typeof requestAnimationFrame !== 'undefined') {
      const loop = () => {
        const pads =
          typeof navigator !== 'undefined' && navigator.getGamepads
            ? navigator.getGamepads()
            : []
        for (const pad of pads) {
          if (!pad) continue
          const prev = prevButtonsRef.current.get(pad.index) ?? []
          for (let i = 0; i < pad.buttons.length; i++) {
            const b = pad.buttons[i]
            const down = b.pressed || b.value > 0.5
            if (down && !prev[i]) cb.current()
            prev[i] = down
          }
          prevButtonsRef.current.set(pad.index, prev)

          // Thumbstick steering as a press. Measure tilt as deviation from the
          // axis's resting baseline (captured on first sight), take the largest
          // across axes, and apply schmitt-trigger hysteresis: fire once when
          // it crosses the press threshold, re-arm only after it drops below
          // the release threshold. Baseline-relative so an axis resting at -1
          // (some triggers) doesn't read as a permanent tilt.
          if (!axisAsPressRef.current) continue
          let baseline = axisBaselineRef.current.get(pad.index)
          if (!baseline || baseline.length !== pad.axes.length) {
            baseline = Array.from(pad.axes)
            axisBaselineRef.current.set(pad.index, baseline)
          }
          let maxDev = 0
          for (let i = 0; i < pad.axes.length; i++) {
            const dev = Math.abs(pad.axes[i] - baseline[i])
            if (dev > maxDev) maxDev = dev
          }
          const wasTilted = prevAxisRef.current.get(pad.index) ?? false
          if (!wasTilted && maxDev >= AXIS_PRESS_THRESHOLD) {
            cb.current()
            prevAxisRef.current.set(pad.index, true)
          } else if (wasTilted && maxDev < AXIS_RELEASE_THRESHOLD) {
            prevAxisRef.current.set(pad.index, false)
          }
        }
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    // Resume the beep AudioContext within this gesture.
    if (!beeperRef.current) beeperRef.current = makeBeeper()
    beeperRef.current.resume()
  }, [])

  const beep = useCallback(() => {
    if (!beeperRef.current) beeperRef.current = makeBeeper()
    beeperRef.current.beep()
  }, [])

  const disarm = useCallback(() => {
    // Release the capture without unmounting the hook: stop gamepad polling,
    // pause the silent keep-alive, and clear the MediaSession handlers +
    // playback state. Called when the test finishes so the remote's button
    // stops hijacking the phone's media session (and stops swallowing taps)
    // on the results screen. Idempotent; the unmount teardown does the same.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      for (const action of MEDIA_ACTIONS) {
        try {
          navigator.mediaSession.setActionHandler(action, null)
        } catch {
          /* ignore */
        }
      }
    }
    // Stop the shared keep-alive now (no debounce) — the test is over, so the
    // user's media should be handed straight back.
    releaseKeepAliveNow()
  }, [])

  return { arm, beep, disarm }
}

// Vertical-axis tilt below this (deviation from the resting baseline) is
// treated as drift and ignored, so an idle stick never ramps the value.
const AXIS_RAMP_DEADZONE = 0.25

/**
 * Continuous thumbstick steering for in-headset value adjustment (e.g. the
 * brightness floor, where a patient wearing the headset can't reach an
 * on-screen slider). While `active`, polls the connected gamepads each frame
 * and calls `onDelta` with a signed amount proportional to the vertical stick
 * tilt and the frame time: pushing the stick **up** yields a positive delta,
 * **down** a negative one. The magnitude is roughly `tilt × seconds`, so a
 * caller scales it by a per-second rate. Unlike the press detection in
 * {@link useRemoteInput}, this reports the analog axis directly; only the
 * vertical axes (odd indices: left-stick Y, right-stick Y) are read so a
 * trigger mapped to an axis can't drive it. No user gesture is required —
 * `navigator.getGamepads()` polling works without one.
 */
export function useThumbstickRamp(onDelta: (delta: number) => void, active: boolean): void {
  const cb = useRef(onDelta)
  useEffect(() => {
    cb.current = onDelta
  }, [onDelta])
  const rafRef = useRef<number | null>(null)
  const baselineRef = useRef<Map<number, number[]>>(new Map())
  const lastTsRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active) return
    if (typeof requestAnimationFrame === 'undefined') return
    const baselineMap = baselineRef.current
    const loop = (ts: number) => {
      const pads =
        typeof navigator !== 'undefined' && navigator.getGamepads
          ? navigator.getGamepads()
          : []
      const last = lastTsRef.current
      // Clamp dt so a long frame (tab unfocused, GC pause) can't jump the
      // value; first frame has no reference so dt is 0.
      const dt = last === null ? 0 : Math.min(0.05, (ts - last) / 1000)
      lastTsRef.current = ts
      let tilt = 0
      for (const pad of pads) {
        if (!pad) continue
        let baseline = baselineMap.get(pad.index)
        if (!baseline || baseline.length !== pad.axes.length) {
          baseline = Array.from(pad.axes)
          baselineMap.set(pad.index, baseline)
        }
        for (let i = 1; i < pad.axes.length; i += 2) {
          const dev = pad.axes[i] - baseline[i]
          if (Math.abs(dev) > Math.abs(tilt)) tilt = dev
        }
      }
      // Gamepad Y axes are positive-down, so negate: up → positive delta.
      if (dt > 0 && Math.abs(tilt) > AXIS_RAMP_DEADZONE) cb.current(-tilt * dt)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastTsRef.current = null
      baselineMap.clear()
    }
  }, [active])
}

// Keys that ramp a value up / down for an in-headset adjustment. Volume keys
// lead because the common cheap VR remote enumerates as a Bluetooth
// keyboard/media device whose rocker sends AudioVolumeUp/Down — the Gamepad API
// (see useThumbstickRamp) never sees it, so the thumbstick path is dead on
// those remotes. Arrow / Page keys cover presenter-style remotes and a paired
// physical keyboard.
const RAMP_UP_KEYS = new Set<string>(['ArrowUp', 'AudioVolumeUp', 'PageUp'])
const RAMP_DOWN_KEYS = new Set<string>(['ArrowDown', 'AudioVolumeDown', 'PageDown'])

/**
 * Discrete up/down ramping for in-headset value adjustment via a keyboard-style
 * remote — the case {@link useThumbstickRamp} can't serve because the remote
 * isn't a gamepad. While `active`, listens for the volume/arrow up/down keys
 * and calls `onStep(+1)` for up (louder/brighter/outward) or `onStep(-1)` for
 * down. Holding a key relies on the OS key-repeat to produce a continuous ramp;
 * single taps give fine control. `preventDefault` stops a volume key from also
 * nudging system media volume where the browser lets us cancel it.
 */
export function useKeyRamp(onStep: (dir: 1 | -1) => void, active: boolean): void {
  const cb = useRef(onStep)
  useEffect(() => {
    cb.current = onStep
  }, [onStep])
  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      const dir = RAMP_UP_KEYS.has(e.key) ? 1 : RAMP_DOWN_KEYS.has(e.key) ? -1 : 0
      if (dir === 0) return
      e.preventDefault()
      cb.current(dir)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}

/**
 * Visible countdown that fires `onFire` exactly once when it reaches zero —
 * the "timer" half of the in-headset remote+timer flow. Once the phone is in
 * the headset the patient can't reach the touchscreen, so every screen that
 * would otherwise wait for a button press also runs this countdown: if no
 * remote press arrives, the screen advances on its own and the phone never
 * has to come out.
 *
 * Returns the whole seconds remaining (for an on-screen readout) while
 * `active`, or `null` when inactive. The countdown restarts whenever `active`
 * flips true or `resetKey` changes — pass a value that changes on user input
 * (e.g. the brightness being ramped) so an in-progress adjustment keeps
 * pushing the deadline out instead of being cut off mid-tweak.
 */
export function useCountdownAdvance(
  active: boolean,
  seconds: number,
  resetKey: unknown,
  onFire: () => void,
): number | null {
  const [remaining, setRemaining] = useState(seconds)
  const onFireRef = useRef(onFire)
  useEffect(() => {
    onFireRef.current = onFire
  })
  // One interval per active span. The deadline is captured when the effect
  // runs (and recaptured whenever `resetKey` changes — pushing the countdown
  // back out on input), and every tick derives `remaining` from it, so state
  // is only ever set from inside the timer callback, never synchronously in
  // the effect body. `fired` is local to the run so it can't double-fire.
  useEffect(() => {
    if (!active) return
    const deadline = Date.now() + seconds * 1000
    let fired = false
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setRemaining(left)
      if (left <= 0 && !fired) {
        fired = true
        window.clearInterval(id)
        onFireRef.current()
      }
    }, 250)
    return () => window.clearInterval(id)
  }, [active, seconds, resetKey])
  return active ? remaining : null
}
