import { useState, useEffect, useRef, useCallback } from 'react'
import type { CalibrationData, Eye } from '../types'
import { BackButton } from './AccessibleNav'
import { CALIBRATION } from '../constants'
import { formatEyeLabelLong } from '../eyeLabels'

const CREDIT_CARD_WIDTH_MM = 85.6
const CREDIT_CARD_HEIGHT_MM = 53.98
const RT_TRIALS = 5

interface Props {
  eye: Eye
  onCalibrated: (cal: CalibrationData, extendedField: boolean) => void
  onBack: () => void
  /** Skip reaction time calibration (e.g. for ring test where user controls pacing) */
  skipReactionTime?: boolean
  /** Test mode label for the summary screen */
  testMode?: 'goldmann' | 'ring' | 'static'
  /** Mobile phone mode — simplified calibration, short viewing distance */
  mobileMode?: boolean
}

type Step = 'mobile' | 'screen' | 'brightness' | 'reaction' | 'ready'

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

export function CalibrationScreen({ eye, onCalibrated, onBack, skipReactionTime, testMode, mobileMode }: Props) {
  const [step, setStep] = useState<Step>(mobileMode ? 'mobile' : 'screen')
  const totalSteps = skipReactionTime ? 3 : 4 // screen + brightness + (reaction?) + ready
  const stepNumber = step === 'mobile' ? 1 : step === 'screen' ? 1 : step === 'brightness' ? 2 : step === 'reaction' ? 3 : totalSteps

  // Screen calibration
  const [cardWidthPx, setCardWidthPx] = useState(320)
  const [distanceCm, setDistanceCm] = useState(mobileMode ? 5 : 50)

  // Brightness calibration
  const [brightness, setBrightness] = useState(0.5)
  const [brightnessFloor, setBrightnessFloor] = useState(0.04)

  // Extended field
  const [extendedField, setExtendedField] = useState(false)

  // Reaction time calibration
  const [rtStarted, setRtStarted] = useState(false)
  const [rtPhase, setRtPhase] = useState<'waiting' | 'showing' | 'done'>('waiting')
  const [rtTimes, setRtTimes] = useState<number[]>([])
  const [rtCurrent, setRtCurrent] = useState(0)
  const rtStartRef = useRef(0)
  const rtTimeoutRef = useRef(0)

  // Mobile mode: pixel calibration bar length (user adjusts to match 1cm on screen)
  const [mobileBarPx, setMobileBarPx] = useState(100)

  const cardHeightPx = cardWidthPx * (CREDIT_CARD_HEIGHT_MM / CREDIT_CARD_WIDTH_MM)
  // In mobile mode, derive pxPerMm from the calibration bar (mobileBarPx = 10mm = 1cm)
  const pxPerMm = mobileMode ? mobileBarPx / 10 : cardWidthPx / CREDIT_CARD_WIDTH_MM
  const pxPerDeg = pxPerMm * (distanceCm * 10) * Math.tan(Math.PI / 180)

  // Shift fixation toward the nose side so the temporal field (larger in RP) gets more screen
  // In mobile mode, use a smaller offset (10%) since the screen is small
  const fixationOffsetPx = eye === 'right'
    ? -Math.round(window.innerWidth * (mobileMode ? 0.1 : 0.2))
    : Math.round(window.innerWidth * (mobileMode ? 0.1 : 0.2))

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

  const handleScreenDone = () => setStep('brightness')

  const handleBrightnessDone = () => {
    setBrightnessFloor(brightness)
    if (skipReactionTime) {
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
      screenWidthPx: typeof screen !== 'undefined' ? screen.width : window.innerWidth,
      screenHeightPx: typeof screen !== 'undefined' ? screen.height : window.innerHeight,
    }, extendedField)
  }

  // Screen size quality assessment — detect actual mobile vs just a small window
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    && navigator.maxTouchPoints > 0
  const isSmallWindow = !isMobile && (window.innerWidth < 900 || window.innerHeight < 600)

  // Per-direction field coverage (degrees from fixation to each edge)
  const fieldLeft = Math.floor(fixationScreenX / pxPerDeg)
  const fieldRight = Math.floor((window.innerWidth - fixationScreenX) / pxPerDeg)
  const fieldUp = Math.floor((window.innerHeight / 2) / pxPerDeg)
  const fieldDown = fieldUp

  // For the tested eye: map left/right to nasal/temporal
  const fieldTemporal = eye === 'right' ? fieldRight : fieldLeft
  const fieldNasal = eye === 'right' ? fieldLeft : fieldRight

  // ==================== MOBILE CALIBRATION ====================
  if (step === 'mobile') {
    return (
      <div className="min-h-[100dvh] bg-base text-white safe-pad flex items-center justify-center p-6 animate-page-in">
        <main className="max-w-lg w-full space-y-6">
          <BackButton onClick={onBack} />

          <div>
            <p className="text-xs text-zinc-500 mb-1">Phone mode — calibration</p>
            <h1 className="text-2xl font-heading font-bold">Screen &amp; distance</h1>
          </div>

          <div className="bg-amber-900/15 border border-amber-700/30 rounded-xl px-4 py-3 text-xs space-y-1.5">
            <p className="text-amber-400 font-medium">Hold phone in landscape</p>
            <p className="text-amber-400/70">
              Close one eye and hold the phone close (1–10 cm). Only the central
              ~{Math.floor(Math.min(fieldUp, Math.min(fieldLeft, fieldRight)))}° of your visual field will be tested.
            </p>
          </div>

          {/* 1cm calibration bar */}
          <div className="space-y-3">
            <p className="text-sm text-zinc-300">
              Drag until the bar below is exactly <strong>1 cm</strong> long (use a ruler or coin for reference).
            </p>
            <div className="flex justify-center items-center h-12">
              <div
                className="h-3 bg-blue-400 rounded-full"
                style={{ width: mobileBarPx }}
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-500 justify-center">
              <span>← 1 cm →</span>
            </div>
            <input
              type="range"
              min={30}
              max={200}
              value={mobileBarPx}
              onChange={e => setMobileBarPx(Number(e.target.value))}
              aria-label="Calibration bar width — adjust to match 1 cm"
              className="w-full accent-amber-500"
            />
          </div>

          {/* Distance */}
          <div className="space-y-3">
            <p className="text-sm text-zinc-300">
              How far is the phone from your eye?
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={distanceCm}
                onChange={e => setDistanceCm(Number(e.target.value))}
                aria-label={`Phone viewing distance: ${distanceCm} cm`}
                className="flex-1 accent-amber-500"
              />
              <span className="text-accent-light font-mono w-16 text-right">{distanceCm} cm</span>
            </div>
            <div className="text-xs text-zinc-500 flex justify-between">
              <span>1 cm (very close)</span>
              <span>10 cm</span>
            </div>
          </div>

          {/* Field coverage preview */}
          <div className="bg-surface rounded-2xl border border-white/[0.06] px-4 py-3 text-xs space-y-1">
            <p className="text-zinc-400 font-medium">Estimated coverage</p>
            <p className="text-zinc-500">
              Central ~{Math.floor(Math.min(fieldUp, Math.min(fieldLeft, fieldRight)))}° from fixation
              ({fieldTemporal}° temporal, {fieldNasal}° nasal, {fieldUp}° up/down)
            </p>
          </div>

          <button
            onClick={() => setStep('brightness')}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >
            Next
          </button>
        </main>
      </div>
    )
  }

  // ==================== STEP 1: Screen ====================
  if (step === 'screen') {
    return (
      <div className="min-h-[100dvh] bg-base text-white safe-pad flex items-center justify-center p-6 animate-page-in">
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

          <div className="space-y-2">
            <label className="text-sm text-zinc-300 block">
              Viewing distance — sit at arm's length (~50 cm)
            </label>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setDistanceCm(d => Math.max(20, d - 5))}
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
          </div>

          {/* Live field coverage diagram — updates with distance & card size */}
          {(() => {
            const fullW = typeof screen !== 'undefined' ? screen.width : window.innerWidth
            const fullH = typeof screen !== 'undefined' ? screen.height : window.innerHeight
            const fullFixX = fullW / 2 + fixationOffsetPx
            const fTemporal = eye === 'right'
              ? Math.floor((fullW - fullFixX) / pxPerDeg)
              : Math.floor(fullFixX / pxPerDeg)
            const fNasal = eye === 'right'
              ? Math.floor(fullFixX / pxPerDeg)
              : Math.floor((fullW - fullFixX) / pxPerDeg)
            const fUp = Math.floor((fullH / 2) / pxPerDeg)
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

                {/* Extended field toggle */}
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
              </div>
            )
          })()}

          <button
            onClick={handleScreenDone}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >Next</button>
        </main>
      </div>
    )
  }

  // ==================== STEP 2: Brightness ====================
  if (step === 'brightness') {
    return (
      <div className="min-h-[100dvh] bg-base text-white safe-pad flex items-center justify-center p-6 animate-page-in">
        <main className="max-w-lg w-full space-y-8">
          <BackButton onClick={() => setStep('screen')} />

          <StepProgress current={stepNumber} total={totalSteps} />
          <h1 className="text-2xl font-heading font-bold">Brightness calibration</h1>

          <p className="text-sm text-zinc-300">
            Drag the slider down until the dot <strong>just barely disappears</strong> against the background.
          </p>

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
            <span>Invisible</span>
            <span className="flex-1" />
            <span>Clearly visible</span>
          </div>

          <button
            onClick={handleBrightnessDone}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >Confirm — dot is just invisible</button>
        </main>
      </div>
    )
  }

  // ==================== STEP 3: Reaction time ====================
  if (step === 'reaction') {
    if (rtPhase === 'done' || rtTimes.length >= RT_TRIALS) {
      return (
        <div className="min-h-[100dvh] bg-base text-white safe-pad flex items-center justify-center p-6 animate-page-in">
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

            <button
              onClick={() => setStep('ready')}
              className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
            >Next</button>
          </main>
        </div>
      )
    }

    // RT instruction screen
    if (!rtStarted) {
      return (
        <div className="min-h-[100dvh] bg-base text-white safe-pad flex items-center justify-center p-6 animate-page-in">
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
                <p>3. <strong className="text-white">Tap the screen or press Space</strong> as fast as you can when you see it</p>
              </div>
              <p className="text-zinc-500 text-xs">
                Your reaction time is used to compensate for response delay during the visual field test, improving accuracy.
              </p>
            </div>

            <button
              onClick={() => setRtStarted(true)}
              className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
            >Start</button>
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
              : 'Press Space or tap NOW!'}
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

  // ==================== STEP 4: Ready ====================
  return (
    <div className="min-h-[100dvh] bg-base text-white safe-pad flex items-center justify-center p-6 animate-page-in">
      <main className="max-w-lg w-full space-y-8">
        <BackButton onClick={() => setStep(skipReactionTime ? 'brightness' : 'reaction')} />

        <h1 className="text-2xl font-heading font-bold">Ready to test</h1>

        <div className="bg-surface rounded-2xl border border-white/[0.06] p-5 space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-400">Test type</span>
            <span>{testMode === 'static' ? 'Tom (static test)' : testMode === 'ring' ? 'Tom (ring test)' : 'Goldmann (kinetic)'}</span>
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
          {!skipReactionTime && (
            <div className="flex justify-between">
              <span className="text-zinc-400">Reaction time</span>
              <span className="font-mono">{medianRt.toFixed(0)} ms (+{((3 * medianRt) / 1000).toFixed(1)}°)</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-zinc-400">Stimuli</span>
            <span>V4e, III4e, III2e, I4e, I2e</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">{skipReactionTime ? 'Pacing' : 'Adaptive'}</span>
            <span>{skipReactionTime ? 'User-controlled — no time pressure' : 'Yes — problem areas retested'}</span>
          </div>
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
        </div>

        <p className="text-xs text-zinc-500">
          {skipReactionTime
            ? 'Expand the ring outward in each sector. Mark where it disappears and reappears. Takes 2–4 minutes.'
            : `The test runs in phases: initial scan, adaptive refinement, outer boundary, sensitivity, and central detail.${extendedField ? ' Plus 2 extended-field passes (up/down).' : ''} Takes about ${extendedField ? '5–8' : '4–6'} minutes.`
          }
        </p>

        <button
          onClick={handleStart}
          className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
        >Start test</button>
      </main>
    </div>
  )
}
