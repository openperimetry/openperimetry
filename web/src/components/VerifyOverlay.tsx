import { useEffect, useMemo, useRef, useState } from 'react'
import type { TestPoint, Eye, CalibrationData, StimulusKey } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { computeSmoothedBoundary, clampBoundary } from '../isopterCalc'
import type { BoundaryPoint } from '../isopterCalc'

interface Props {
  points: TestPoint[]
  eye: Eye
  calibration: CalibrationData
  onClose: () => void
}

/**
 * Display mode for the verify overlay:
 *  - 'outline'   — thin colour-coded stroke, one line per isopter.
 *  - 'stimulus'  — stroke drawn at the actual stimulus size (width ≈
 *                  sizeDeg × pxPerDeg) and the actual test-time luminance
 *                  (opacity = stimulusOpacity(intensity, floor)). Lets the
 *                  user verify whether their real peripheral fade matches
 *                  the isopter at the brightness and diameter they were
 *                  responding to during the test.
 */
type DisplayMode = 'outline' | 'stimulus'

/** Matches `stimulusOpacity` in GoldmannTest so a verify outline drawn in
 *  stimulus mode has the same perceived brightness as the moving dot did. */
function stimulusOpacity(intensityFrac: number, brightnessFloor: number): number {
  const minUsable = brightnessFloor * 1.5
  return minUsable + (1.0 - minUsable) * intensityFrac
}

// ISO/IEC 7810 ID-1 — same constants used in CalibrationScreen
const CREDIT_CARD_WIDTH_MM = 85.6
const CREDIT_CARD_HEIGHT_MM = 53.98
const TAN_ONE_DEG = Math.tan(Math.PI / 180)

interface ScreenBoundary {
  key: StimulusKey
  pixelPath: string
  fallbackPath: string
  centerX: number
  centerY: number
}

function smoothClosedPath(pts: [number, number][]): string {
  const n = pts.length
  if (n < 3) return ''
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 0; i < n; i++) {
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p0 = pts[(i - 1 + n) % n]
    const p3 = pts[(i + 2) % n]
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`
  }
  return d + ' Z'
}

export function VerifyOverlay({ points, eye, calibration, onClose }: Props) {
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [mode, setMode] = useState<DisplayMode>('outline')
  const [enabled, setEnabled] = useState<Record<StimulusKey, boolean>>({
    V4e: true, III4e: true, III2e: true, I4e: true, I2e: true,
  })
  const [showMissed, setShowMissed] = useState(true)

  // Recalibration: lets the user re-derive pxPerDeg in case their physical
  // setup changed since the test (different distance, different screen).
  const initialCardWidthPx = Math.round(
    (calibration.pixelsPerDegree / (calibration.viewingDistanceCm * 10 * TAN_ONE_DEG)) * CREDIT_CARD_WIDTH_MM,
  )
  const [recalibrating, setRecalibrating] = useState(false)
  const [cardWidthPx, setCardWidthPx] = useState(() => Math.max(150, Math.min(600, initialCardWidthPx)))
  const [distanceCm, setDistanceCm] = useState(calibration.viewingDistanceCm)
  const [overrideActive, setOverrideActive] = useState(false)

  const livePxPerDeg = (cardWidthPx / CREDIT_CARD_WIDTH_MM) * (distanceCm * 10) * TAN_ONE_DEG
  const pxPerDeg = overrideActive ? livePxPerDeg : calibration.pixelsPerDegree
  const liveDistanceCm = overrideActive ? distanceCm : calibration.viewingDistanceCm

  const applyRecalibration = () => {
    setOverrideActive(true)
    setRecalibrating(false)
  }
  const resetRecalibration = () => {
    setOverrideActive(false)
    setRecalibrating(false)
    setCardWidthPx(Math.max(150, Math.min(600, initialCardWidthPx)))
    setDistanceCm(calibration.viewingDistanceCm)
  }

  // Stimulus replay state
  const detectedPoints = useMemo(() => points.filter(p => p.detected), [points])
  const [replayIdx, setReplayIdx] = useState(0)
  const [flashing, setFlashing] = useState(false)
  const flashTimerRef = useRef<number>(0)

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        triggerFlash()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayIdx, detectedPoints.length])

  useEffect(() => () => { if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current) }, [])

  const triggerFlash = () => {
    if (detectedPoints.length === 0) return
    setFlashing(true)
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => {
      setFlashing(false)
      setReplayIdx(i => (i + 1) % detectedPoints.length)
    }, 600)
  }

  // Place the fixation at the same offset used during the test, so the user
  // can position their eye in the same physical spot. Clamp into the viewport
  // in case the new screen is smaller than the one the test was recorded on.
  const margin = 40
  const rawCx = viewport.w / 2 + calibration.fixationOffsetPx
  const cx = Math.max(margin, Math.min(viewport.w - margin, rawCx))
  const cy = viewport.h / 2

  // Did the current window shrink compared to the screen the test was run
  // on? If so, outer isopters (V4e / III4e) can physically extend past the
  // current viewport — the isopter geometry is fixed in pixel space, but the
  // available screen is smaller. We SVG-clip so overflow doesn't paint over
  // the UI chrome, and surface a warning banner.
  const testScreenW = calibration.screenWidthPx
  const testScreenH = calibration.screenHeightPx
  const windowShrunk =
    (testScreenW != null && testScreenW > viewport.w + 2) ||
    (testScreenH != null && testScreenH > viewport.h + 2)

  // Effective eye for orientation. Binocular results show right by default.
  const renderEye: 'left' | 'right' = eye === 'left' ? 'left' : 'right'

  // Smoothed boundaries per stimulus, in screen pixels. Walks outer → inner
  // and clamps each dimmer isopter to never exceed the previous brighter
  // one at the same meridian — kinetic isopters are strictly nested by
  // construction (dimmer light ⇒ smaller detection area), so any crossing
  // is test noise or a misclick and would render as a visually wrong
  // dim-outside-bright pattern without this step.
  const boundaries: ScreenBoundary[] = useMemo(() => {
    const grouped: Partial<Record<StimulusKey, TestPoint[]>> = {}
    for (const p of points) {
      if (!grouped[p.stimulus]) grouped[p.stimulus] = []
      grouped[p.stimulus]!.push(p)
    }
    const out: ScreenBoundary[] = []
    let prevBoundary: BoundaryPoint[] | null = null
    for (const key of ISOPTER_ORDER) {
      const detected = (grouped[key] ?? []).filter(p => p.detected)
      if (detected.length < 3) continue
      let smoothed = computeSmoothedBoundary(detected)
      if (smoothed.length < 3) continue
      if (prevBoundary) smoothed = clampBoundary(smoothed, prevBoundary)
      prevBoundary = smoothed
      const pixelPts = smoothed.map(b => {
        const theta = (b.meridianDeg * Math.PI) / 180
        const r = b.eccentricityDeg * pxPerDeg
        return [cx + r * Math.cos(theta), cy - r * Math.sin(theta)] as [number, number]
      })
      out.push({
        key,
        pixelPath: smoothClosedPath(pixelPts),
        fallbackPath: '',
        centerX: cx,
        centerY: cy,
      })
    }
    return out
  }, [points, pxPerDeg, cx, cy])

  // Missed points in pixel coordinates
  const missed = useMemo(
    () =>
      points
        .filter(p => !p.detected)
        .map(p => {
          const theta = (p.meridianDeg * Math.PI) / 180
          const r = p.eccentricityDeg * pxPerDeg
          return {
            x: cx + r * Math.cos(theta),
            y: cy - r * Math.sin(theta),
            stim: p.stimulus,
          }
        }),
    [points, pxPerDeg, cx, cy],
  )

  const flashPoint = flashing && detectedPoints[replayIdx]
    ? (() => {
        const p = detectedPoints[replayIdx]
        const theta = (p.meridianDeg * Math.PI) / 180
        const r = p.eccentricityDeg * pxPerDeg
        return { x: cx + r * Math.cos(theta), y: cy - r * Math.sin(theta), stim: p.stimulus }
      })()
    : null

  const upcomingPoint = detectedPoints[replayIdx]

  return (
    <div className="fixed inset-0 z-50 bg-black text-white" role="dialog" aria-label="Verify visual field at 1:1 scale">
      <svg
        width={viewport.w}
        height={viewport.h}
        viewBox={`0 0 ${viewport.w} ${viewport.h}`}
        className="block absolute inset-0"
      >
        <defs>
          {/* Constrains isopter + missed-point rendering to the visible
              viewport. Without this, outer isopters (V4e / III4e) recorded
              on a larger screen extend past the window edges and paint the
              UI chrome. The 1px inset avoids half-pixel edge bleed. */}
          <clipPath id="verify-viewport-clip">
            <rect x={1} y={1} width={Math.max(0, viewport.w - 2)} height={Math.max(0, viewport.h - 2)} />
          </clipPath>
        </defs>
        {/* Degree arcs centred on fixation. Step is 10° unless the largest
            isopter is small, in which case 5° is more useful. Each ring is
            labelled along the horizontal so the user can read "where" their
            real field actually fades. */}
        {(() => {
          const maxEccPx = Math.max(viewport.w, viewport.h)
          const maxRing = Math.ceil((maxEccPx / pxPerDeg) / 5) * 5
          const step = maxRing <= 30 ? 5 : 10
          const rings: number[] = []
          for (let d = step; d <= maxRing; d += step) rings.push(d)
          return (
            <g aria-hidden="true">
              {rings.map(deg => (
                <circle
                  key={deg}
                  cx={cx}
                  cy={cy}
                  r={deg * pxPerDeg}
                  fill="none"
                  stroke="#27272a"
                  strokeWidth={deg % (step * 2) === 0 ? 1 : 0.5}
                />
              ))}
              {rings.map(deg => (
                <text
                  key={`l-${deg}`}
                  x={cx + deg * pxPerDeg + 4}
                  y={cy - 3}
                  fill="#52525b"
                  fontSize={10}
                  fontFamily="monospace"
                >
                  {deg}°
                </text>
              ))}
              {/* Cardinal axis lines */}
              <line x1={cx - maxEccPx} y1={cy} x2={cx + maxEccPx} y2={cy} stroke="#27272a" strokeWidth={0.5} />
              <line x1={cx} y1={cy - maxEccPx} x2={cx} y2={cy + maxEccPx} stroke="#27272a" strokeWidth={0.5} />
            </g>
          )
        })()}

        {/* Isopter contours.
            'outline' mode draws a thin colour-coded stroke.
            'stimulus' mode draws each isopter with a white stroke whose
            width equals the stimulus diameter (sizeDeg × pxPerDeg) and
            whose opacity matches the test-time luminance — so the
            perceived visual weight of the contour is the same as the dot
            the user was chasing during the test.
            Wrapped in a viewport-clipped group so outer isopters that
            physically exceed the current window don't bleed into the UI
            chrome. */}
        <g clipPath="url(#verify-viewport-clip)">
        {boundaries.map(({ key, pixelPath }) => {
          if (!enabled[key]) return null
          const stim = STIMULI[key]
          if (mode === 'stimulus') {
            const strokeWidth = Math.max(1, stim.sizeDeg * pxPerDeg)
            const strokeOpacity = stimulusOpacity(stim.intensityFrac, calibration.brightnessFloor)
            return (
              <path
                key={key}
                d={pixelPath}
                fill="none"
                stroke="white"
                strokeWidth={strokeWidth}
                strokeOpacity={strokeOpacity}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )
          }
          return (
            <path
              key={key}
              d={pixelPath}
              fill="none"
              stroke={stim.color}
              strokeWidth={2}
              strokeOpacity={0.85}
            />
          )
        })}

        {/* Missed points (per-stimulus colored hollow rings) */}
        {showMissed && missed.map((m, i) => {
          if (!enabled[m.stim]) return null
          const color = STIMULI[m.stim]?.color ?? '#ef4444'
          return <circle key={`m-${i}`} cx={m.x} cy={m.y} r={3} fill="none" stroke={color} strokeWidth={1} opacity={0.7} />
        })}
        </g>

        {/* Flashing replay stimulus */}
        {flashPoint && (
          <circle cx={flashPoint.x} cy={flashPoint.y} r={Math.max(3, STIMULI[flashPoint.stim].sizeDeg * pxPerDeg / 2)} fill="white" />
        )}

        {/* Fixation cross at screen center */}
        <line x1={cx - 8} y1={cy} x2={cx + 8} y2={cy} stroke="#fbbf24" strokeWidth={2} />
        <line x1={cx} y1={cy - 8} x2={cx} y2={cy + 8} stroke="#fbbf24" strokeWidth={2} />
        <circle cx={cx} cy={cy} r={3} fill="#fbbf24" />
      </svg>

      {/* Top-left instruction strip */}
      <div className="absolute top-4 left-4 max-w-md bg-white/[0.06] backdrop-blur-md rounded-xl border border-white/[0.08] p-4 space-y-2">
        <h2 className="text-sm font-heading font-bold">Verify at 1:1 scale</h2>
        <p className="text-xs text-zinc-300 leading-relaxed">
          Cover your <strong className="text-white">{renderEye === 'right' ? 'left' : 'right'}</strong> eye and sit{' '}
          <strong className="text-white">~{Math.round(liveDistanceCm)} cm</strong> from the screen
          {overrideActive ? ' (recalibrated)' : ' — the same distance you tested at'}. Fixate the yellow cross. The
          contours show where your tested isopters were; they should line up with where your peripheral vision fades.
        </p>
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          Keep fixating steadily for 10–20 seconds — the contours should progressively fade from
          awareness, peripheral ones first, dimmer ones fastest (Troxler&apos;s fading). That&apos;s a
          normal brain phenomenon, not vision loss: blink or glance away a hair and they snap back.
          It&apos;s the same effect that makes static peripheral stimuli fade at the edge of your field,
          and it&apos;s the reason the kinetic test uses a <em>moving</em> dot — movement defeats
          Troxler, so the boundary the test draws is where your retina actually stopped responding.
        </p>
        <p className="text-[11px] text-zinc-500">
          Press <kbd className="px-1 py-0.5 bg-white/[0.06] rounded text-zinc-300">Space</kbd> to flash a recorded
          test point. Press <kbd className="px-1 py-0.5 bg-white/[0.06] rounded text-zinc-300">Esc</kbd> to close.
        </p>
        {windowShrunk && (
          <p className="text-[11px] text-amber-400 leading-snug border-t border-white/[0.08] pt-2">
            This window is smaller than the screen the test was run on
            ({testScreenW ?? '?'}×{testScreenH ?? '?'}px). Outer isopters that
            extend beyond the current viewport are clipped — go fullscreen or
            use the same display for an accurate 1:1 check.
          </p>
        )}
      </div>

      {/* Inline recalibration panel — shown when the user clicks Recalibrate */}
      {recalibrating && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="max-w-md w-full mx-4 bg-surface border border-white/[0.10] rounded-2xl p-6 space-y-5">
            <div className="space-y-1">
              <h3 className="text-base font-heading font-bold">Recalibrate for verify</h3>
              <p className="text-xs text-zinc-400">
                Hold a bank card to your screen and drag the slider until the rectangle matches its size, then enter
                your current viewing distance. The contours will rescale to match.
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex justify-center">
                <div
                  className="border-2 border-dashed border-accent rounded-lg flex items-center justify-center text-accent-light text-[11px]"
                  style={{ width: cardWidthPx, height: cardWidthPx * (CREDIT_CARD_HEIGHT_MM / CREDIT_CARD_WIDTH_MM) }}
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

            <div className="space-y-2">
              <label className="text-sm text-zinc-300 block">Viewing distance</label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setDistanceCm(d => Math.max(20, d - 5))}
                  className="w-10 h-10 rounded bg-white/[0.06] hover:bg-white/[0.10] text-lg"
                  aria-label="Decrease viewing distance"
                >−</button>
                <span className="text-2xl font-mono w-20 text-center" aria-live="polite">{distanceCm} cm</span>
                <button
                  onClick={() => setDistanceCm(d => Math.min(100, d + 5))}
                  className="w-10 h-10 rounded bg-white/[0.06] hover:bg-white/[0.10] text-lg"
                  aria-label="Increase viewing distance"
                >+</button>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setRecalibrating(false)}
                className="flex-1 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-sm font-medium text-zinc-300"
              >
                Cancel
              </button>
              <button
                onClick={applyRecalibration}
                className="flex-1 py-2 btn-primary rounded-lg text-sm font-medium text-white"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top-right controls */}
      <div className="absolute top-4 right-4 w-60 bg-white/[0.06] backdrop-blur-md rounded-xl border border-white/[0.08] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-zinc-500">Display</span>
          <button
            onClick={onClose}
            aria-label="Close verify view"
            className="text-zinc-400 hover:text-white text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex gap-1 rounded-lg bg-white/[0.04] p-1">
          <button
            onClick={() => setMode('outline')}
            className={`flex-1 py-1.5 rounded text-xs font-medium ${mode === 'outline' ? 'bg-white/[0.10] text-white' : 'text-zinc-400'}`}
            title="Thin colour-coded boundary contours"
          >
            Outline
          </button>
          <button
            onClick={() => setMode('stimulus')}
            className={`flex-1 py-1.5 rounded text-xs font-medium ${mode === 'stimulus' ? 'bg-white/[0.10] text-white' : 'text-zinc-400'}`}
            title="Draw each boundary at the actual stimulus size and luminance used during the test"
          >
            Stimulus size
          </button>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs uppercase tracking-wider text-zinc-500">Isopters</span>
          {ISOPTER_ORDER.map(key => {
            const has = boundaries.some(b => b.key === key)
            if (!has) return null
            return (
              <label key={key} className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300 hover:text-white">
                <input
                  type="checkbox"
                  checked={enabled[key]}
                  onChange={e => setEnabled(s => ({ ...s, [key]: e.target.checked }))}
                  className="accent-amber-500"
                />
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: STIMULI[key].color }} />
                <span>{STIMULI[key].label}</span>
              </label>
            )
          })}
          <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300 hover:text-white pt-1 border-t border-white/[0.05] mt-1">
            <input
              type="checkbox"
              checked={showMissed}
              onChange={e => setShowMissed(e.target.checked)}
              className="accent-amber-500"
            />
            <span className="inline-block w-2 h-2 rounded-full border border-zinc-400" />
            <span>Missed points</span>
          </label>
        </div>

        <div className="pt-2 border-t border-white/[0.05] space-y-1">
          <span className="text-xs uppercase tracking-wider text-zinc-500">Replay</span>
          <button
            onClick={triggerFlash}
            disabled={detectedPoints.length === 0}
            className="w-full py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] text-xs font-medium disabled:opacity-30"
          >
            Flash next point ({detectedPoints.length === 0 ? '0' : `${replayIdx + 1}/${detectedPoints.length}`})
          </button>
          {upcomingPoint && (
            <p className="text-[11px] text-zinc-500">
              Next:{' '}
              <span className="font-mono" style={{ color: STIMULI[upcomingPoint.stimulus].color }}>
                {STIMULI[upcomingPoint.stimulus].label}
              </span>{' '}
              at {upcomingPoint.eccentricityDeg.toFixed(1)}° / {Math.round(upcomingPoint.meridianDeg)}°
            </p>
          )}
        </div>

        <div className="pt-2 border-t border-white/[0.05] space-y-1">
          <span className="text-xs uppercase tracking-wider text-zinc-500">Calibration</span>
          <p className="text-[11px] text-zinc-500 leading-tight">
            {pxPerDeg.toFixed(1)} px/° at {Math.round(liveDistanceCm)} cm.{' '}
            Screen edge ≈{' '}
            <span className="font-mono text-zinc-300">
              {Math.round(Math.min(cx, viewport.w - cx) / pxPerDeg)}°
            </span>{' '}
            horizontal,{' '}
            <span className="font-mono text-zinc-300">
              {Math.round((viewport.h / 2) / pxPerDeg)}°
            </span>{' '}
            vertical.
          </p>
          <button
            onClick={() => setRecalibrating(true)}
            className="w-full py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] text-xs font-medium"
          >
            Recalibrate{overrideActive ? ' (active)' : ''}
          </button>
          {overrideActive && (
            <button
              onClick={resetRecalibration}
              className="w-full py-1 text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              Reset to test values
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
