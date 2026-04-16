import { useState, useEffect } from 'react'
import type { CalibrationData, Eye, TestPoint } from './types'
import { CalibrationScreen } from './components/CalibrationScreen'
import { GoldmannTest, type SpeedMode } from './components/GoldmannTest'
import { RingTest } from './components/RingTest'
import { StaticTest } from './components/StaticTest'
import { TestDemo } from './components/TestDemo'
import { BinocularResults } from './components/BinocularResults'
import { HistoryView } from './components/HistoryView'
import { ScienceReferences } from './components/ScienceReferences'
import { MethodsPage } from './components/MethodsPage'
import { AboutPage } from './components/AboutPage'
import { ContactPage } from './components/ContactPage'
import { PrivacyPage } from './components/PrivacyPage'
import { AdminPage } from './components/AdminPage'
import { AuthModal } from './components/AuthModal'
import { ClinicalDisclaimer } from './components/ClinicalDisclaimer'
import { useAuth } from './AuthContext'
import { getResults } from './storage'
import { APP_NAME, APP_DOMAIN, APP_TAGLINE, TITLE_SUFFIX, HAS_ABOUT_PAGE } from './branding'

type Page = 'home' | 'calibration' | 'test' | 'ring-test' | 'static-test' | 'binocular-switch' | 'binocular-test-left' | 'binocular-results' | 'history' | 'demo' | 'science' | 'methods' | 'about' | 'contact' | 'privacy' | 'admin'
type TestMode = 'goldmann' | 'ring' | 'static'

const UMAMI_WEBSITE_ID = (import.meta.env.VITE_UMAMI_WEBSITE_ID as string | undefined) ?? ''
const UMAMI_SCRIPT_URL = (import.meta.env.VITE_UMAMI_SCRIPT_URL as string | undefined) ?? 'https://cloud.umami.is/script.js'
const UMAMI_HOST_URL = (import.meta.env.VITE_UMAMI_HOST_URL as string | undefined) ?? ''

const PAGE_TITLES: Record<Page, string> = {
  home: `${APP_NAME} — ${APP_TAGLINE}`,
  calibration: `Calibration${TITLE_SUFFIX}`,
  test: `Testing${TITLE_SUFFIX}`,
  'ring-test': `Ring Test${TITLE_SUFFIX}`,
  'static-test': `Static Test${TITLE_SUFFIX}`,
  'binocular-switch': `Switch Eye${TITLE_SUFFIX}`,
  'binocular-test-left': `Left Eye Test${TITLE_SUFFIX}`,
  'binocular-results': `Binocular Results${TITLE_SUFFIX}`,
  history: `Results${TITLE_SUFFIX}`,
  demo: `Clinical Demos${TITLE_SUFFIX}`,
  science: `Scientific References${TITLE_SUFFIX}`,
  methods: `Methods & Parameters${TITLE_SUFFIX}`,
  about: `About${TITLE_SUFFIX}`,
  contact: `Contact${TITLE_SUFFIX}`,
  privacy: `Privacy Policy${TITLE_SUFFIX}`,
  admin: `Admin${TITLE_SUFFIX}`,
}

// Detect mobile device (touch + mobile UA)
const detectMobile = () =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && navigator.maxTouchPoints > 0

function App() {
  const [page, setPage] = useState<Page>('home')
  const [eye, setEye] = useState<Eye>('right')
  const [calibration, setCalibration] = useState<CalibrationData | null>(null)
  const [extendedField, setExtendedField] = useState(false)
  const [testMode, setTestMode] = useState<TestMode>('goldmann')
  const [mobileMode, setMobileMode] = useState(false)
  const [speedMode, setSpeedMode] = useState<SpeedMode>('normal')
  const isMobile = detectMobile()
const [showAuth, setShowAuth] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return !!params.get('resetToken')
  })
  const { user, logout, syncResults } = useAuth()

  // Update document title on page change
  useEffect(() => {
    document.title = PAGE_TITLES[page]
  }, [page])

  // Inject Umami analytics script
  useEffect(() => {
    if (!UMAMI_WEBSITE_ID) return
    if (document.querySelector('script[data-vfc-umami="true"]')) return
    const script = document.createElement('script')
    script.defer = true
    script.src = UMAMI_SCRIPT_URL
    script.setAttribute('data-vfc-umami', 'true')
    script.setAttribute('data-website-id', UMAMI_WEBSITE_ID)
    script.setAttribute('data-auto-track', 'true')
    if (UMAMI_HOST_URL) {
      script.setAttribute('data-host-url', UMAMI_HOST_URL)
    }
    document.head.appendChild(script)
  }, [])

  // Dev-only: ?dev=goldmann|static|ring[&mobile=1][&eye=right|left|both]
  // skips calibration with a prebaked CalibrationData and jumps straight to
  // the test. Intended for local development & preview verification only.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const devMode = params.get('dev')
    if (!devMode || !['goldmann', 'static', 'ring'].includes(devMode)) return
    const devMobile = params.get('mobile') === '1'
    const devEye = (params.get('eye') as Eye) || 'right'
    const distanceCm = devMobile ? 5 : 50
    const pxPerDeg = devMobile ? 18 : 36
    const fakeCal: CalibrationData = {
      pixelsPerDegree: pxPerDeg,
      maxEccentricityDeg: devMobile ? 30 : 40,
      viewingDistanceCm: distanceCm,
      brightnessFloor: 0.2,
      reactionTimeMs: 400,
      fixationOffsetPx: devEye === 'left'
        ? -Math.round(window.innerWidth * (devMobile ? 0.1 : 0.2))
        : Math.round(window.innerWidth * (devMobile ? 0.1 : 0.2)),
      screenWidthPx: typeof screen !== 'undefined' ? screen.width : window.innerWidth,
      screenHeightPx: typeof screen !== 'undefined' ? screen.height : window.innerHeight,
    }
    setEye(devEye)
    setMobileMode(devMobile)
    setTestMode(devMode as TestMode)
    setCalibration(fakeCal)
    setExtendedField(false)
    setPage(devMode === 'ring' ? 'ring-test' : devMode === 'static' ? 'static-test' : 'test')
  }, [])

  // Binocular flow state
  const [rightPoints, setRightPoints] = useState<TestPoint[]>([])
  const [leftPoints, setLeftPoints] = useState<TestPoint[]>([])

  const resultCount = getResults().length

  const startTest = (selectedEye: Eye) => {
    setEye(selectedEye)
    setPage('calibration')
  }

  const handleCalibrated = (cal: CalibrationData, extended: boolean) => {
    setCalibration(cal)
    setExtendedField(extended)
    setPage(testMode === 'ring' ? 'ring-test' : testMode === 'static' ? 'static-test' : 'test')
  }

  const handleDone = () => {
    setPage('home')
    if (user) syncResults()
  }

  // ── Binocular flow ──
  // For binocular: calibration uses right eye first (CalibrationScreen handles the offset)
  // After right eye test completes → switch screen → left eye test → combined results

  const handleBinocularCalibrated = (cal: CalibrationData, extended: boolean) => {
    setCalibration(cal)
    setExtendedField(extended)
    setPage(testMode === 'ring' ? 'ring-test' : testMode === 'static' ? 'static-test' : 'test')
  }

  const handleRightEyeComplete = (points: TestPoint[]) => {
    setRightPoints(points)
    setPage('binocular-switch')
  }

  const handleLeftEyeComplete = (points: TestPoint[]) => {
    setLeftPoints(points)
    setPage('binocular-results')
  }

  // Calibration — for 'both', calibrate for right eye first
  if (page === 'calibration') {
    const calEye = eye === 'both' ? 'right' : eye
    return (
      <CalibrationScreen
        eye={calEye}
        onCalibrated={eye === 'both' ? handleBinocularCalibrated : handleCalibrated}
        onBack={() => setPage('home')}
        skipReactionTime={testMode === 'ring' || testMode === 'static'}
        testMode={testMode}
        mobileMode={mobileMode}
      />
    )
  }

  // Ring test
  if (page === 'ring-test' && calibration) {
    return (
      <RingTest
        key={eye === 'both' ? 'binocular-right' : 'single'}
        eye={eye === 'both' ? 'right' : eye}
        calibration={calibration}
        extendedField={extendedField}
        onDone={handleDone}
        onComplete={eye === 'both' ? handleRightEyeComplete : undefined}
      />
    )
  }

  // Static test
  if (page === 'static-test' && calibration) {
    return (
      <StaticTest
        key={eye === 'both' ? 'binocular-right' : 'single'}
        eye={eye === 'both' ? 'right' : eye}
        calibration={calibration}
        extendedField={extendedField}
        onDone={handleDone}
        onComplete={eye === 'both' ? handleRightEyeComplete : undefined}
      />
    )
  }

  // Single-eye test
  if (page === 'test' && calibration && eye !== 'both') {
    return (
      <GoldmannTest
        eye={eye}
        calibration={calibration}
        extendedField={extendedField}
        onDone={handleDone}
        speedMode={speedMode}
      />
    )
  }

  // Binocular: right eye test
  if (page === 'test' && calibration && eye === 'both') {
    return (
      <GoldmannTest
        key="binocular-right"
        eye="right"
        calibration={calibration}
        extendedField={extendedField}
        onDone={handleDone}
        onComplete={handleRightEyeComplete}
        speedMode={speedMode}
      />
    )
  }

  // Binocular: switch eyes interstitial
  if (page === 'binocular-switch') {
    return (
      <div className="min-h-[100dvh] bg-base text-white flex items-center justify-center p-6 safe-pad">
        <main className="max-w-sm w-full space-y-8 text-center animate-page-in">
          <div className="w-20 h-20 mx-auto rounded-full bg-teal/10 flex items-center justify-center border border-teal/20">
            <svg viewBox="0 0 24 24" className="w-10 h-10 text-teal" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-heading font-bold">Right eye done!</h1>
            <p className="text-zinc-400">
              Now switch to your <span className="text-white font-semibold">left eye (<abbr title="Oculus Sinister">OS</abbr>)</span>.
            </p>
          </div>

          <div className="bg-surface rounded-2xl p-5 space-y-3 text-sm text-left border border-white/[0.06]">
            <div className="flex gap-3 items-start">
              <span className="text-accent font-heading font-bold mt-0.5">1.</span>
              <p className="text-zinc-300">Cover your <strong className="text-white">right</strong> eye</p>
            </div>
            <div className="flex gap-3 items-start">
              <span className="text-accent font-heading font-bold mt-0.5">2.</span>
              <p className="text-zinc-300">Position yourself so your nose aligns with the <strong className="text-white">right edge</strong> of the screen</p>
            </div>
            <div className="flex gap-3 items-start">
              <span className="text-accent font-heading font-bold mt-0.5">3.</span>
              <p className="text-zinc-300">Take a moment to rest if needed</p>
            </div>
          </div>

          <button
            onClick={() => setPage('binocular-test-left')}
            className="w-full py-3 btn-primary rounded-xl text-lg font-medium text-white"
          >
            Start left eye test
          </button>

          <button
            onClick={() => {
              // Skip left eye — go to results with just right eye
              setLeftPoints([])
              setPage('binocular-results')
            }}
            className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors min-h-[44px] px-3"
          >
            Skip — show right eye results only
          </button>
        </main>
      </div>
    )
  }

  // Binocular: left eye test
  if (page === 'binocular-test-left' && calibration) {
    // Compute left-eye calibration: mirror the fixation offset
    const leftCalibration: CalibrationData = {
      ...calibration,
      fixationOffsetPx: -calibration.fixationOffsetPx,
    }
    if (testMode === 'ring') {
      return (
        <RingTest
          key="binocular-left"
          eye="left"
          calibration={leftCalibration}
          extendedField={extendedField}
          onDone={handleDone}
          onComplete={handleLeftEyeComplete}
        />
      )
    }
    if (testMode === 'static') {
      return (
        <StaticTest
          key="binocular-left"
          eye="left"
          calibration={leftCalibration}
          extendedField={extendedField}
          onDone={handleDone}
          onComplete={handleLeftEyeComplete}
        />
      )
    }
    return (
      <GoldmannTest
        key="binocular-left"
        eye="left"
        calibration={leftCalibration}
        extendedField={extendedField}
        onDone={handleDone}
        speedMode={speedMode}
        onComplete={handleLeftEyeComplete}
      />
    )
  }

  // Binocular: combined results
  if (page === 'binocular-results' && calibration) {
    return (
      <BinocularResults
        rightPoints={rightPoints}
        leftPoints={leftPoints}
        calibration={calibration}
        maxEccentricity={calibration.maxEccentricityDeg}
        onDone={handleDone}
      />
    )
  }

  if (page === 'history') {
    return <HistoryView onBack={() => setPage('home')} />
  }

  if (page === 'demo') {
    return <TestDemo onBack={() => setPage('home')} />
  }

  if (page === 'about') {
    // About page is a creator bio — hosted instance ships it, forks default
    // to hiding it. Navigation by URL hash lands here but we bounce back to
    // home when the feature is disabled.
    if (!HAS_ABOUT_PAGE) {
      setPage('home')
      return null
    }
    return <AboutPage onBack={() => setPage('home')} />
  }

  if (page === 'contact') {
    return <ContactPage onBack={() => setPage('home')} />
  }

  if (page === 'privacy') {
    return <PrivacyPage onBack={() => setPage('home')} />
  }

  if (page === 'science') {
    return <ScienceReferences onBack={() => setPage('home')} />
  }

  if (page === 'methods') {
    return <MethodsPage onBack={() => setPage('home')} />
  }

  if (page === 'admin') {
    return <AdminPage onBack={() => setPage('home')} />
  }

  // Home
  const goldmannTime = speedMode === 'fast' ? '~5 min' : '~15 min'
  const goldmannTimeBoth = speedMode === 'fast' ? '~10 min' : '~30 min'
  const duration = testMode === 'ring' ? '~3 min' : testMode === 'static' ? '~8 min' : goldmannTime
  const durationBoth = testMode === 'ring' ? '~6 min' : testMode === 'static' ? '~16 min' : goldmannTimeBoth

  return (
    <div className="min-h-[100dvh] bg-base text-white flex flex-col items-center justify-center relative overflow-hidden grain safe-pad">
      {/* ── Perimetry chart hero ── */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ marginTop: '-6vh' }} aria-hidden="true">
        <div className="absolute w-[650px] h-[650px] bg-radial-glow" />
        <svg
          viewBox="0 0 500 500"
          className="w-[min(92vw,540px)] h-[min(92vw,540px)] hero-chart-enter chart-breathe"
        >
          <defs>
            <radialGradient id="cg">
              <stop offset="0%" stopColor="rgba(200,144,42,0.04)" />
              <stop offset="70%" stopColor="rgba(200,144,42,0)" />
            </radialGradient>
          </defs>
          <circle cx={250} cy={250} r={230} fill="url(#cg)" />

          {/* Meridian lines */}
          {[0, 30, 60, 90, 120, 150].map(deg => {
            const rad = (deg * Math.PI) / 180
            const r = 220
            return (
              <line
                key={deg}
                x1={250 + r * Math.cos(rad)} y1={250 - r * Math.sin(rad)}
                x2={250 - r * Math.cos(rad)} y2={250 + r * Math.sin(rad)}
                stroke={`rgba(200,144,42,${deg % 90 === 0 ? 0.09 : 0.04})`}
                strokeWidth={deg % 90 === 0 ? 0.8 : 0.5}
              />
            )
          })}

          {/* Concentric rings */}
          {[40, 80, 120, 160, 200].map((r, i) => (
            <circle
              key={r}
              cx={250} cy={250} r={r}
              fill="none"
              stroke={`rgba(200,144,42,${0.22 - i * 0.035})`}
              strokeWidth={i < 2 ? 1.5 : 1}
            />
          ))}

          {/* Degree labels */}
          <text x={250} y={28} textAnchor="middle" fill="rgba(200,144,42,0.2)" fontSize={10} fontFamily="Outfit, sans-serif">90°</text>
          <text x={478} y={254} textAnchor="end" fill="rgba(200,144,42,0.2)" fontSize={10} fontFamily="Outfit, sans-serif">0°</text>
          <text x={250} y={480} textAnchor="middle" fill="rgba(200,144,42,0.2)" fontSize={10} fontFamily="Outfit, sans-serif">270°</text>
          <text x={24} y={254} textAnchor="start" fill="rgba(200,144,42,0.2)" fontSize={10} fontFamily="Outfit, sans-serif">180°</text>

          {/* Animated stimulus — varies by test type */}
          {testMode === 'goldmann' && (() => {
            // Kinetic perimetry: dots move inward along meridians. Speed depends on speedMode.
            const cycleDur = speedMode === 'fast' ? 6 : 12
            const dots = [
              { angle: 25, delay: 0 },
              { angle: 160, delay: cycleDur / 3 },
              { angle: 280, delay: (cycleDur * 2) / 3 },
            ]
            return dots.map(({ angle, delay }) => {
              const rad = (angle * Math.PI) / 180
              const cos = Math.cos(rad)
              const sin = Math.sin(rad)
              const sx = Math.round(250 + 195 * cos)
              const sy = Math.round(250 - 195 * sin)
              const ex = Math.round(250 + 35 * cos)
              const ey = Math.round(250 - 35 * sin)
              return (
                // Base cx/cy/opacity must be set: SMIL falls back to attribute
                // defaults (cx=0, cy=0, opacity=1) before `begin`, which would
                // park the delayed dots at the chart's top-left corner.
                <circle key={`g-${angle}-${cycleDur}`} cx={sx} cy={sy} r={3} fill="#c8902a" opacity={0}>
                  <animate attributeName="cx" dur={`${cycleDur}s`} repeatCount="indefinite" begin={`${delay}s`}
                    values={`${sx};${sx};${ex};${ex};${ex}`} keyTimes="0;0.02;0.3;0.33;1" />
                  <animate attributeName="cy" dur={`${cycleDur}s`} repeatCount="indefinite" begin={`${delay}s`}
                    values={`${sy};${sy};${ey};${ey};${ey}`} keyTimes="0;0.02;0.3;0.33;1" />
                  <animate attributeName="opacity" dur={`${cycleDur}s`} repeatCount="indefinite" begin={`${delay}s`}
                    values="0;0.5;0.5;0;0" keyTimes="0;0.02;0.28;0.33;1" />
                </circle>
              )
            })
          })()}

          {testMode === 'ring' && [0, 2, 4].map(delay => (
            // Ring test: concentric rings expand outward from fixation like a sonar pulse
            <circle key={`r-${delay}`} cx={250} cy={250} r={20} fill="none" stroke="#c8902a" strokeWidth={1.5} opacity={0}>
              <animate attributeName="r" dur="6s" repeatCount="indefinite" begin={`${delay}s`}
                values="20;210" keyTimes="0;1" />
              <animate attributeName="opacity" dur="6s" repeatCount="indefinite" begin={`${delay}s`}
                values="0;0.55;0.4;0" keyTimes="0;0.15;0.7;1" />
              <animate attributeName="stroke-width" dur="6s" repeatCount="indefinite" begin={`${delay}s`}
                values="2;0.6" keyTimes="0;1" />
            </circle>
          ))}

          {testMode === 'static' && [
            // Static perimetry: dots flash briefly at scattered positions
            { angle: 35, ecc: 70, delay: 0 },
            { angle: 110, ecc: 130, delay: 0.6 },
            { angle: 200, ecc: 90, delay: 1.2 },
            { angle: 305, ecc: 160, delay: 1.8 },
            { angle: 70, ecc: 180, delay: 2.4 },
            { angle: 240, ecc: 50, delay: 3.0 },
            { angle: 150, ecc: 195, delay: 3.6 },
            { angle: 350, ecc: 110, delay: 4.2 },
          ].map(({ angle, ecc, delay }) => {
            const rad = (angle * Math.PI) / 180
            const cx = Math.round(250 + ecc * Math.cos(rad))
            const cy = Math.round(250 - ecc * Math.sin(rad))
            return (
              <circle key={`s-${angle}-${ecc}`} cx={cx} cy={cy} r={3} fill="#c8902a" opacity={0}>
                <animate attributeName="opacity" dur="5s" repeatCount="indefinite" begin={`${delay}s`}
                  values="0;0;0.7;0.7;0;0" keyTimes="0;0.05;0.08;0.16;0.2;1" />
              </circle>
            )
          })}

          {/* Fixation point with pulse */}
          <circle cx={250} cy={250} r={5} fill="#c8902a" opacity={0.6}>
            <animate attributeName="r" values="4;7;4" dur="4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.4;0.85;0.4" dur="4s" repeatCount="indefinite" />
          </circle>
        </svg>
      </div>

      {/* ── Content ── */}
      <main className="relative z-10 max-w-md w-full px-6 py-10 space-y-8 text-center">
        {/* Brand — at the fixation point of the chart */}
        <div className="fade-up fade-up-1 space-y-3 pt-6 pb-2">
          <h1 className="min-h-[5.5rem] sm:min-h-[6.5rem] flex flex-col items-center justify-center">
            <span className="text-6xl sm:text-7xl font-heading font-extrabold tracking-tighter text-white leading-[0.9]">
              {testMode === 'ring' ? 'Ring' : testMode === 'static' ? 'Static' : 'Goldmann'}
            </span>
            <span className="block text-accent text-2xl sm:text-3xl tracking-[0.15em] uppercase font-heading font-bold mt-1">
              Visual Field
            </span>
          </h1>
          <p className="text-zinc-500 text-xs tracking-[0.1em]">
            {APP_DOMAIN}
          </p>
        </div>

        <p className="fade-up fade-up-2 text-zinc-400 text-sm max-w-xs mx-auto min-h-[2.5rem] flex items-center justify-center">
          <span>
            {testMode === 'ring'
              ? 'Ring-based scotoma mapping'
              : testMode === 'static'
              ? 'Adaptive static perimetry'
              : <>Kinetic perimetry self-check for <abbr title="Retinitis Pigmentosa" className="no-underline">RP</abbr></>}
          </span>
        </p>

        {/* ── Eye selection ── */}
        <div className="fade-up fade-up-3 space-y-3">
          <p className="text-zinc-500 text-[11px] font-medium uppercase tracking-[0.2em]" id="eye-selection-label">Select eye</p>
          <div className="grid grid-cols-[1fr_1.15fr_1fr] gap-2.5" role="group" aria-labelledby="eye-selection-label">
            <button
              onClick={() => startTest('left')}
              aria-label="Test left eye (OS)"
              className="group relative py-5 min-h-[88px] bg-white/[0.03] backdrop-blur-sm rounded-2xl font-medium transition-all duration-300 border border-white/[0.06] hover:border-accent/30 hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base hover:scale-[1.03] hover:shadow-[0_4px_24px_rgba(200,144,42,0.08)]"
            >
              <svg viewBox="0 0 32 32" className="w-8 h-8 mx-auto mb-2 text-zinc-500 group-hover:text-accent transition-colors duration-300" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <ellipse cx="16" cy="16" rx="13" ry="8" />
                <circle cx="14" cy="16" r="5" />
                <circle cx="13" cy="15.5" r="2" fill="currentColor" />
              </svg>
              <span className="block text-lg font-heading font-semibold text-white">Left</span>
              <span className="text-zinc-500 text-xs"><abbr title="Oculus Sinister">OS</abbr> · {duration}</span>
            </button>

            <button
              onClick={() => startTest('both')}
              aria-label="Test both eyes (OU)"
              className="group relative py-5 min-h-[88px] bg-white/[0.04] backdrop-blur-sm rounded-2xl font-medium transition-all duration-300 border border-accent/15 hover:border-accent/40 hover:bg-white/[0.07] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base hover:scale-[1.03] shadow-[0_0_24px_rgba(200,144,42,0.04)] hover:shadow-[0_4px_32px_rgba(200,144,42,0.12)]"
            >
              <svg viewBox="0 0 40 32" className="w-10 h-8 mx-auto mb-2 text-zinc-500 group-hover:text-accent transition-colors duration-300" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <ellipse cx="13" cy="16" rx="10" ry="7" />
                <circle cx="11.5" cy="16" r="3.5" />
                <circle cx="11" cy="15.5" r="1.5" fill="currentColor" />
                <ellipse cx="27" cy="16" rx="10" ry="7" />
                <circle cx="28.5" cy="16" r="3.5" />
                <circle cx="29" cy="15.5" r="1.5" fill="currentColor" />
              </svg>
              <span className="block text-lg font-heading font-semibold text-white">Both</span>
              <span className="text-accent/50 text-xs"><abbr title="Oculus Uterque">OU</abbr> · {durationBoth}</span>
            </button>

            <button
              onClick={() => startTest('right')}
              aria-label="Test right eye (OD)"
              className="group relative py-5 min-h-[88px] bg-white/[0.03] backdrop-blur-sm rounded-2xl font-medium transition-all duration-300 border border-white/[0.06] hover:border-accent/30 hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base hover:scale-[1.03] hover:shadow-[0_4px_24px_rgba(200,144,42,0.08)]"
            >
              <svg viewBox="0 0 32 32" className="w-8 h-8 mx-auto mb-2 text-zinc-500 group-hover:text-accent transition-colors duration-300" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <ellipse cx="16" cy="16" rx="13" ry="8" />
                <circle cx="18" cy="16" r="5" />
                <circle cx="19" cy="15.5" r="2" fill="currentColor" />
              </svg>
              <span className="block text-lg font-heading font-semibold text-white">Right</span>
              <span className="text-zinc-500 text-xs"><abbr title="Oculus Dexter">OD</abbr> · {duration}</span>
            </button>
          </div>
        </div>

        {/* ── Test mode + speed toggle ── */}
        <div className="fade-up fade-up-4 space-y-3">
          <p className="text-zinc-500 text-[11px] font-medium uppercase tracking-[0.2em]">Test type</p>
          <div className="flex justify-center gap-2" role="tablist" aria-label="Test mode">
            {(['goldmann', 'ring', 'static'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setTestMode(mode)}
                role="tab"
                aria-selected={testMode === mode}
                className={`relative min-h-[44px] px-5 pb-2 pt-3 text-sm font-medium transition-all duration-200 ${
                  testMode === mode ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {mode === 'goldmann' ? 'Goldmann' : mode === 'ring' ? 'Ring' : 'Static'}
                <span className={`absolute bottom-1 inset-x-4 h-[2px] rounded-full bg-accent transition-all duration-300 origin-center ${
                  testMode === mode ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0'
                }`} />
              </button>
            ))}
          </div>

          {/* Speed toggle — always present to avoid layout shift, invisible when not goldmann */}
          <button
            onClick={() => setSpeedMode(s => s === 'normal' ? 'fast' : 'normal')}
            role="switch"
            aria-checked={speedMode === 'fast'}
            tabIndex={testMode === 'goldmann' ? 0 : -1}
            aria-hidden={testMode !== 'goldmann'}
            className={`w-full py-2.5 rounded-xl text-sm font-medium border backdrop-blur-sm ${
              testMode !== 'goldmann'
                ? 'invisible'
                : speedMode === 'fast'
                  ? 'bg-accent/10 border-accent/25 text-accent-light'
                  : 'bg-white/[0.02] border-white/[0.06] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
            }`}
          >
            <svg className="inline w-4 h-4 mr-1.5 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            {speedMode === 'fast' ? 'Fast mode — ~5 min' : 'Normal speed — ~15 min'}
          </button>
        </div>

        {/* Mobile mode toggle — only shown on mobile devices */}
        {isMobile && (
          <div className="fade-up fade-up-5 space-y-2">
            <button
              onClick={() => setMobileMode(m => !m)}
              role="switch"
              aria-checked={mobileMode}
              className={`w-full py-3 rounded-xl text-sm font-medium transition-all border backdrop-blur-sm ${
                mobileMode
                  ? 'bg-amber-600/15 border-amber-600/30 text-amber-300'
                  : 'bg-white/[0.02] border-white/[0.06] text-zinc-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <rect x="5" y="2" width="14" height="20" rx="2" />
                <line x1="12" y1="18" x2="12" y2="18" strokeWidth={2} strokeLinecap="round" />
              </svg>
              {mobileMode ? 'Phone mode active' : 'Enable phone mode'}
            </button>
            {mobileMode && (
              <div className="bg-amber-900/15 border border-amber-700/30 rounded-xl px-4 py-3 text-xs text-left space-y-1.5">
                <p className="text-amber-400 font-medium">Phone mode</p>
                <p className="text-amber-400/70">
                  Hold your phone in landscape, roughly 10&ndash;15&nbsp;cm from your eye.
                  Only the central visual field can be tested on a small screen &mdash; useful for
                  quick central-field checks, but it can&rsquo;t replace a full test on a large monitor.
                </p>
                <p className="text-amber-400/70">
                  Static test works best in phone mode; kinetic tests (Goldmann, Ring) were designed for
                  larger screens and may feel cramped.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Quick actions row */}
        <div className="fade-up fade-up-6 flex gap-3">
          {resultCount > 0 && (
            <button
              onClick={() => setPage('history')}
              className="flex-1 py-3 min-h-[48px] bg-white/[0.03] backdrop-blur-sm hover:bg-white/[0.06] rounded-xl font-medium transition-all border border-white/[0.06] hover:border-white/[0.12] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base"
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M12 8v4l3 3" />
                <circle cx="12" cy="12" r="10" />
              </svg>
              Results
              <span className="ml-1.5 text-zinc-500 text-sm">({resultCount})</span>
            </button>
          )}
          {!user && (
            <button
              onClick={() => setShowAuth(true)}
              className={`${resultCount > 0 ? 'flex-1' : 'w-full'} py-3 min-h-[48px] text-sm text-zinc-300 hover:text-white bg-white/[0.02] backdrop-blur-sm hover:bg-white/[0.05] rounded-xl transition-all border border-white/[0.06] hover:border-white/[0.12] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base`}
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              Sign in
            </button>
          )}
        </div>

        {/* Account (when logged in) */}
        {user && (
          <div className="fade-up fade-up-6 flex items-center justify-center gap-3 text-sm">
            <span className="text-zinc-400">
              <svg className="inline w-4 h-4 mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              {user.displayName}
            </span>
            {user.isAdmin && (
              <button
                onClick={() => setPage('admin')}
                className="text-accent hover:text-accent-light transition-colors min-h-[44px] px-2"
              >
                Admin
              </button>
            )}
            <button
              onClick={logout}
              className="text-zinc-500 hover:text-zinc-300 transition-colors min-h-[44px] px-2"
            >
              Sign out
            </button>
          </div>
        )}

        {/* Clinical disclaimer */}
        <div className="fade-up fade-up-7">
          <ClinicalDisclaimer variant="home" />
        </div>

        {/* Footer navigation */}
        <nav aria-label="Site navigation" className="fade-up fade-up-8 pt-2 border-t border-white/[0.05]">
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
            <button onClick={() => setPage('demo')} className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-1">Demos</button>
            <button onClick={() => setPage('methods')} className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-1">Methods</button>
            <button onClick={() => setPage('science')} className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-1">References</button>
            {HAS_ABOUT_PAGE && (
              <button onClick={() => setPage('about')} className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-1">About</button>
            )}
            <button onClick={() => setPage('contact')} className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-1">Contact</button>
            <button onClick={() => setPage('privacy')} className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-1">Privacy</button>
          </div>
        </nav>

      </main>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </div>
  )
}

export default App
