import { useEffect, useState } from 'react'
import type { CalibrationData, Eye, TestPoint } from './types'
import { CalibrationScreen } from './components/CalibrationScreen'
import { GoldmannTest, type SpeedMode } from './components/GoldmannTest'
import { StaticTest } from './components/StaticTest'
import { TestDemo } from './components/TestDemo'
import { BinocularResults } from './components/BinocularResults'
import { HistoryView } from './components/HistoryView'
import { ScienceReferences } from './components/ScienceReferences'
import { MethodsPage } from './components/MethodsPage'
import { ContactPage } from './components/ContactPage'
import { PrivacyPage } from './components/PrivacyPage'
import { AdminPage } from './components/AdminPage'
import { AuthModal } from './components/AuthModal'
import { ClinicalDisclaimer } from './components/ClinicalDisclaimer'
import { ClinicianPortal } from './components/ClinicianPortal'
import { useAuth } from './AuthContext'
import { ADVANCED_SETTINGS_CTX, type AdvancedSettings } from './advancedSettings'
import type { ReactNode } from 'react'
import { getDeviceId, getResults } from './storage'
import { APP_NAME, APP_DOMAIN, APP_TAGLINE, TITLE_SUFFIX, GITHUB_URL, HAS_GITHUB_LINK, whatsappShareUrl } from './branding'
import { trackEvent } from './api'
import { DEFAULT_STUDY_MODE_STATE, isStudyReady, useSetStudyMode, useStudyMode } from './studyMode'

type Page = 'home' | 'calibration' | 'test' | 'static-test' | 'binocular-switch' | 'binocular-test-left' | 'binocular-results' | 'history' | 'demo' | 'science' | 'methods' | 'contact' | 'privacy' | 'admin' | 'clinician'
type TestMode = 'goldmann' | 'static'

const UMAMI_WEBSITE_ID = (import.meta.env.VITE_UMAMI_WEBSITE_ID as string | undefined) ?? ''
const UMAMI_SCRIPT_URL = (import.meta.env.VITE_UMAMI_SCRIPT_URL as string | undefined) ?? 'https://cloud.umami.is/script.js'
const UMAMI_HOST_URL = (import.meta.env.VITE_UMAMI_HOST_URL as string | undefined) ?? ''

const PAGE_TITLES: Record<Page, string> = {
  home: `${APP_NAME} — ${APP_TAGLINE}`,
  calibration: `Calibration${TITLE_SUFFIX}`,
  test: `Testing${TITLE_SUFFIX}`,
  'static-test': `Static Test${TITLE_SUFFIX}`,
  'binocular-switch': `Switch Eye${TITLE_SUFFIX}`,
  'binocular-test-left': `Left Eye Test${TITLE_SUFFIX}`,
  'binocular-results': `Binocular Results${TITLE_SUFFIX}`,
  history: `Results${TITLE_SUFFIX}`,
  demo: `Clinical Demos${TITLE_SUFFIX}`,
  science: `Scientific References${TITLE_SUFFIX}`,
  methods: `Methods & Parameters${TITLE_SUFFIX}`,
  contact: `Contact${TITLE_SUFFIX}`,
  privacy: `Privacy Policy${TITLE_SUFFIX}`,
  admin: `Admin${TITLE_SUFFIX}`,
  clinician: `Clinician Portal${TITLE_SUFFIX}`,
}

// Home-picker preference persistence. Tiny, isolated helpers — saved
// independently of advancedSettings so the clinician portal's study
// runs (which use a transient runConfig) can never overwrite the
// user's home-screen defaults.
const HOME_TEST_MODE_KEY = 'vfc-home-test-mode'
const HOME_SPEED_MODE_KEY = 'vfc-home-speed-mode'

function loadHomeTestMode(): TestMode {
  try {
    const raw = localStorage.getItem(HOME_TEST_MODE_KEY)
    if (raw === 'goldmann' || raw === 'static') return raw
  } catch { /* ignore */ }
  return 'goldmann'
}

function loadHomeSpeedMode(): SpeedMode {
  try {
    const raw = localStorage.getItem(HOME_SPEED_MODE_KEY)
    if (raw === 'slow' || raw === 'normal') return raw
  } catch { /* ignore */ }
  return 'normal'
}

function saveHomeTestMode(v: TestMode) {
  try { localStorage.setItem(HOME_TEST_MODE_KEY, v) } catch { /* ignore */ }
}

function saveHomeSpeedMode(v: SpeedMode) {
  try { localStorage.setItem(HOME_SPEED_MODE_KEY, v) } catch { /* ignore */ }
}

// Context boundary that swaps the advanced-settings value seen by the
// subtree when a study run is active, without mutating the
// AdvancedSettingsRoot's persisted state. Test/calibration pages read
// from useAdvancedSettings(), so this is sufficient to scope the
// override to the run.
function RunAdvancedBoundary({ override, children }: { override: AdvancedSettings | null; children: ReactNode }) {
  if (!override) return <>{children}</>
  return <ADVANCED_SETTINGS_CTX.Provider value={override}>{children}</ADVANCED_SETTINGS_CTX.Provider>
}

function durationFor(testMode: TestMode, speedMode: SpeedMode, binocular: boolean): string {
  if (testMode === 'goldmann') {
    if (speedMode === 'slow') return binocular ? '~30 min' : '~15 min'
    return binocular ? '~10 min' : '~5 min'
  }
  // Static.
  if (speedMode === 'slow') return binocular ? '~28–36 min' : '~14–18 min'
  return binocular ? '~14–20 min' : '~7–10 min'
}

function App() {
  const [page, setPage] = useState<Page>('home')
  const [eye, setEye] = useState<Eye>('right')
  const [calibration, setCalibration] = useState<CalibrationData | null>(null)
  const [extendedField, setExtendedField] = useState(false)
  // Home picker — the user's personal-test preferences. Persisted to
  // localStorage so they survive reloads. Never mutated by the
  // clinician portal; study runs build their own runConfig instead.
  const [testMode, setTestMode] = useState<TestMode>(() => loadHomeTestMode())
  const [speedMode, setSpeedMode] = useState<SpeedMode>(() => loadHomeSpeedMode())
  useEffect(() => { saveHomeTestMode(testMode) }, [testMode])
  useEffect(() => { saveHomeSpeedMode(speedMode) }, [speedMode])
  const studyMode = useStudyMode()
  const setStudyMode = useSetStudyMode()
  // Active run config — set when a test launches (either from home or
  // from the clinician portal) and consumed by the calibration/test
  // pages. A non-null `advancedOverride` switches the test subtree to
  // a study profile's advanced settings without touching the user's
  // persistent home-picker preferences.
  const [runConfig, setRunConfig] = useState<{
    testMode: TestMode
    speedMode: SpeedMode
    advancedOverride: AdvancedSettings | null
  }>({ testMode: 'goldmann', speedMode: 'normal', advancedOverride: null })

  const [showAuth, setShowAuth] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return !!params.get('resetToken')
  })
  // Most visitors are first-time users, so the modal defaults to register
  // mode. An explicit "Already have an account? Sign in" link flips this
  // to 'login' before opening the modal.
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register')
  const { user, loading: authLoading, logout, deleteAccount, syncResults } = useAuth()
  // Self-delete modal. Mirrors the admin pattern — require typing the
  // displayName before the destructive button enables.
  const [showDeleteAccount, setShowDeleteAccount] = useState(false)
  const [deleteAccountTyped, setDeleteAccountTyped] = useState('')
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false)
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null)
  const closeDeleteAccountModal = () => {
    if (deleteAccountBusy) return
    setShowDeleteAccount(false)
    setDeleteAccountTyped('')
    setDeleteAccountError(null)
  }
  const confirmDeleteOwnAccount = async () => {
    if (!user || deleteAccountTyped.trim() !== user.displayName) return
    setDeleteAccountBusy(true)
    setDeleteAccountError(null)
    try {
      await deleteAccount()
      // AuthContext will null out user; reset modal + navigate home so
      // the deleted user isn't left staring at a page that assumed
      // them logged in.
      setShowDeleteAccount(false)
      setDeleteAccountTyped('')
      setPage('home')
    } catch (err) {
      setDeleteAccountError((err as Error).message ?? 'Failed to delete account.')
    } finally {
      setDeleteAccountBusy(false)
    }
  }
  const canUseStudyMode = user?.isAdmin === true || user?.isClinician === true

  // (Removed) Auto-syncing a selected study profile onto the home
  // picker's testMode/speedMode/advancedSettings made the home screen
  // a slave to the portal — picking a profile would lock the home
  // tabs and force the user to clear the session before running a
  // personal test. The home screen and the clinician portal are now
  // independent: the profile's settings are applied only at the
  // moment a run starts from the portal (see the onStartTest handler
  // below), and restored on done/cancel.

  useEffect(() => {
    if (authLoading || canUseStudyMode) return
    if (!studyMode.enabled && studyMode.profile == null) return
    setStudyMode(DEFAULT_STUDY_MODE_STATE)
  }, [authLoading, canUseStudyMode, studyMode.enabled, studyMode.profile, setStudyMode])

  // Update document title on page change and send a virtual pageview to
  // Umami. This is a client-rendered SPA so the URL never changes on
  // navigation — without this the auto-tracker only records a single '/'
  // pageview per session.
  useEffect(() => {
    document.title = PAGE_TITLES[page]
    const umami = (window as unknown as { umami?: { track: (fn: (props: Record<string, unknown>) => Record<string, unknown>) => void } }).umami
    umami?.track(props => ({ ...props, url: `/${page}`, title: PAGE_TITLES[page] }))
  }, [page])

  // Let child components (e.g. SavePrompt on results screens) open the
  // auth modal without prop-drilling setShowAuth through the tree.
  // Emitters may include a `mode` detail to pick between login/register
  // — defaults to register since most openers are new-user prompts.
  useEffect(() => {
    const open = (e: Event) => {
      const detail = (e as CustomEvent<{ mode?: 'login' | 'register' }>).detail
      setAuthMode(detail?.mode ?? 'register')
      setShowAuth(true)
    }
    window.addEventListener('vfc:show-auth', open)
    return () => window.removeEventListener('vfc:show-auth', open)
  }, [])

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

  // Dev-only: ?dev=goldmann|static[&eye=right|left|both]
  // skips calibration with a prebaked CalibrationData and jumps straight to
  // the test. Intended for local development & preview verification only.
  // Wrapped in queueMicrotask so the setState batch runs outside the
  // effect body (satisfies react-hooks/set-state-in-effect).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const devMode = params.get('dev')
    if (!devMode || !['goldmann', 'static'].includes(devMode)) return
    queueMicrotask(() => {
      const devEye = (params.get('eye') as Eye) || 'right'
      const fakeCal: CalibrationData = {
        pixelsPerDegree: 36,
        maxEccentricityDeg: 40,
        viewingDistanceCm: 50,
        brightnessFloor: 0.2,
        reactionTimeMs: 400,
        fixationOffsetPx: devEye === 'left'
          ? -Math.round(window.innerWidth * 0.2)
          : Math.round(window.innerWidth * 0.2),
        screenWidthPx: typeof screen !== 'undefined' ? screen.width : window.innerWidth,
        screenHeightPx: typeof screen !== 'undefined' ? screen.height : window.innerHeight,
      }
      setEye(devEye)
      setTestMode(devMode as TestMode)
      setRunConfig({ testMode: devMode as TestMode, speedMode: 'normal', advancedOverride: null })
      setCalibration(fakeCal)
      setExtendedField(false)
      setPage(devMode === 'static' ? 'static-test' : 'test')
    })
  }, [])

  // Binocular flow state
  const [rightPoints, setRightPoints] = useState<TestPoint[]>([])
  const [leftPoints, setLeftPoints] = useState<TestPoint[]>([])

  const resultCount = getResults().length
  const studyLocked = canUseStudyMode && studyMode.enabled && studyMode.profile != null
  const studyReady = studyLocked ? isStudyReady(studyMode) : true

  // Launch a personal test using the home picker's current values.
  // Home state is never mutated past this point — `runConfig` carries
  // the active values into the test pages.
  const startTest = (selectedEye: Eye) => {
    setRunConfig({ testMode, speedMode, advancedOverride: null })
    setEye(selectedEye)
    setPage('calibration')
  }

  // Launch a study run from the clinician portal. Builds a runConfig
  // from the active profile and flips studyMode.enabled so results
  // get tagged. Crucially, this never writes to the home picker —
  // the user's personal preferences stay intact.
  const startStudyRunFromPortal = (selectedEye: Eye) => {
    if (!studyMode.profile) {
      startTest(selectedEye)
      return
    }
    const profile = studyMode.profile
    setRunConfig({
      testMode: profile.testType,
      speedMode: profile.speedMode,
      advancedOverride: profile.advancedSettings,
    })
    setStudyMode({ ...studyMode, enabled: true })
    setEye(selectedEye)
    setPage('calibration')
  }

  // Clear the study flag at the end of a run (or on cancel). No
  // restore step is needed because the home picker was never touched.
  const finishStudyRun = () => {
    if (studyMode.enabled) {
      setStudyMode({ ...studyMode, enabled: false })
    }
  }

  const handleCalibrated = (cal: CalibrationData, extended: boolean) => {
    setCalibration(cal)
    setExtendedField(extended)
    setPage(testMode === 'static' ? 'static-test' : 'test')
  }

  const handleDone = () => {
    finishStudyRun()
    setPage('home')
    if (user) syncResults()
  }

  // ── Binocular flow ──
  // For binocular: calibration uses right eye first (CalibrationScreen handles the offset)
  // After right eye test completes → switch screen → left eye test → combined results

  const handleBinocularCalibrated = (cal: CalibrationData, extended: boolean) => {
    setCalibration(cal)
    setExtendedField(extended)
    setPage(testMode === 'static' ? 'static-test' : 'test')
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
      <RunAdvancedBoundary override={runConfig.advancedOverride}>
        <CalibrationScreen
          eye={calEye}
          onCalibrated={eye === 'both' ? handleBinocularCalibrated : handleCalibrated}
          onBack={() => {
            // Backing out of calibration cancels an in-flight study
            // run too — clear the study flag so the next launch from
            // home isn't accidentally tagged as a study session.
            finishStudyRun()
            setPage('home')
          }}
          skipReactionTime={runConfig.testMode === 'static'}
          testMode={runConfig.testMode}
        />
      </RunAdvancedBoundary>
    )
  }

  // Static test
  if (page === 'static-test' && calibration) {
    return (
      <RunAdvancedBoundary override={runConfig.advancedOverride}>
        <StaticTest
          key={eye === 'both' ? 'binocular-right' : 'single'}
          eye={eye === 'both' ? 'right' : eye}
          calibration={calibration}
          extendedField={extendedField}
          onDone={handleDone}
          onComplete={eye === 'both' ? handleRightEyeComplete : undefined}
          speedMode={runConfig.speedMode}
        />
      </RunAdvancedBoundary>
    )
  }

  // Single-eye test
  if (page === 'test' && calibration && eye !== 'both') {
    return (
      <RunAdvancedBoundary override={runConfig.advancedOverride}>
        <GoldmannTest
          eye={eye}
          calibration={calibration}
          extendedField={extendedField}
          onDone={handleDone}
          speedMode={runConfig.speedMode}
        />
      </RunAdvancedBoundary>
    )
  }

  // Binocular: right eye test
  if (page === 'test' && calibration && eye === 'both') {
    return (
      <RunAdvancedBoundary override={runConfig.advancedOverride}>
        <GoldmannTest
          key="binocular-right"
          eye="right"
          calibration={calibration}
          extendedField={extendedField}
          onDone={handleDone}
          onComplete={handleRightEyeComplete}
          speedMode={runConfig.speedMode}
        />
      </RunAdvancedBoundary>
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
    if (runConfig.testMode === 'static') {
      return (
        <RunAdvancedBoundary override={runConfig.advancedOverride}>
          <StaticTest
            key="binocular-left"
            eye="left"
            calibration={leftCalibration}
            extendedField={extendedField}
            onDone={handleDone}
            onComplete={handleLeftEyeComplete}
            speedMode={runConfig.speedMode}
          />
        </RunAdvancedBoundary>
      )
    }
    return (
      <RunAdvancedBoundary override={runConfig.advancedOverride}>
        <GoldmannTest
          key="binocular-left"
          eye="left"
          calibration={leftCalibration}
          extendedField={extendedField}
          onDone={handleDone}
          speedMode={runConfig.speedMode}
          onComplete={handleLeftEyeComplete}
        />
      </RunAdvancedBoundary>
    )
  }

  // Binocular: combined results
  if (page === 'binocular-results' && calibration) {
    return (
      <RunAdvancedBoundary override={runConfig.advancedOverride}>
        <BinocularResults
          rightPoints={rightPoints}
          leftPoints={leftPoints}
          calibration={calibration}
          maxEccentricity={calibration.maxEccentricityDeg}
          testMode={runConfig.testMode}
          speedMode={runConfig.speedMode}
          extendedField={extendedField}
          onDone={handleDone}
        />
      </RunAdvancedBoundary>
    )
  }

  if (page === 'history') {
    return <HistoryView onBack={() => setPage('home')} />
  }

  if (page === 'demo') {
    return <TestDemo onBack={() => setPage('home')} />
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

  if (page === 'clinician') {
    if (canUseStudyMode) return (
      <ClinicianPortal
        onBack={() => setPage('home')}
        onStartTest={startStudyRunFromPortal}
      />
    )
    return (
      <div className="min-h-[100dvh] bg-base text-white safe-pad p-6 animate-page-in">
        <main className="mx-auto max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-heading font-bold">Clinician access required</h1>
          <p className="text-sm text-zinc-400">Sign in with a clinician account to manage participants and protocols.</p>
          <button onClick={() => setPage('home')} className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white">
            Back to home
          </button>
        </main>
      </div>
    )
  }

  // Home
  // Per-mode durations. Static "fast" runs the 2-reversal
  // staircase (stim 200 ms, gap 700–900 ms, ~4–5 trials per location),
  // matching the 8–12 min/eye budget of the SuperFast 48-point reference
  // protocol (Dzwiniel et al. 2017, PLoS ONE 12(10):e0186224). Static
  // "normal" runs the 4-reversal clinical staircase (stim 500 ms, gap
  // 350–650 ms, ~7–9 trials per location) over the same 54-point HFA
  // 24-2 grid. Goldmann "normal" is the shorter kinetic screen; "slow"
  // preserves the older longer timing and denser I2e pass.
  // The OS and OD buttons always advertise single-eye time (clicking them
  // sets eye='left'/'right' and runs one eye). The OU button advertises
  // the both-eye total. The Normal/Fast speed toggle below is selection-
  // aware: it quotes whichever run length the current eye selection would
  // trigger so users see the time they're actually committing to.
  const durationSingle = durationFor(testMode, speedMode, false)
  const durationBoth = durationFor(testMode, speedMode, true)
  const durationSelected = eye === 'both' ? durationBoth : durationSingle

  return (
    <div className="min-h-[100dvh] bg-base text-white flex flex-col items-center justify-center relative overflow-hidden grain safe-pad">
      {/* ── Perimetry chart hero ──
          Aesthetic: the chart is the hero, not wallpaper. Earlier ring
          opacities (~0.05–0.22) read as a ghost; bumped 2–3× so the
          chart reads as a real instrument bezel on the page. The UI
          card's readability is preserved with a radial dim vignette
          that darkens the centre (where the card sits) while leaving
          the outer bezel bright. Added:
            - Bolder "scope ring" at 60° eccentricity with tick marks
              every 15° (12 ticks, longer at cardinals/intercardinals).
            - Cardinal AND intercardinal degree labels in mono caps.
            - Eccentricity annotation on the scope ring.
            - Tripled meridian/ring/label opacities.
          All geometry stays in the 500×500 viewBox; no layout churn. */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ marginTop: '-6vh' }} aria-hidden="true">
        <div className="absolute w-[650px] h-[650px] bg-radial-glow" />
        <svg
          viewBox="0 0 500 500"
          className="w-[min(96vw,620px)] h-[min(96vw,620px)] hero-chart-enter chart-breathe"
        >
          <defs>
            <radialGradient id="cg">
              <stop offset="0%" stopColor="rgba(200,144,42,0.05)" />
              <stop offset="70%" stopColor="rgba(200,144,42,0)" />
            </radialGradient>
            {/* Radial dim — darkens the centre (where the UI card sits)
                so the scope can be bold without muddying the foreground.
                Applied AFTER the chart elements, BEFORE the animated
                stimuli so the moving dots still pop. */}
            <radialGradient id="dim" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(8,8,13,0.88)" />
              <stop offset="30%" stopColor="rgba(8,8,13,0.68)" />
              <stop offset="58%" stopColor="rgba(8,8,13,0)" />
            </radialGradient>
          </defs>
          <circle cx={250} cy={250} r={230} fill="url(#cg)" />

          {/* Meridian lines — dialled back ~25% from the first bezel
              rework to let the UI card breathe. Still clearly visible,
              no longer competing with the foreground. */}
          {[0, 30, 45, 60, 90, 120, 135, 150].map(deg => {
            const rad = (deg * Math.PI) / 180
            const r = 228
            const isCardinal = deg % 90 === 0
            const isIntercardinal = deg % 45 === 0 && !isCardinal
            return (
              <line
                key={deg}
                x1={250 + r * Math.cos(rad)} y1={250 - r * Math.sin(rad)}
                x2={250 - r * Math.cos(rad)} y2={250 + r * Math.sin(rad)}
                stroke={`rgba(200,144,42,${isCardinal ? 0.14 : isIntercardinal ? 0.09 : 0.05})`}
                strokeWidth={isCardinal ? 0.9 : 0.5}
              />
            )
          })}

          {/* Concentric rings — scope ring at r=180 (60° ecc) is still
              the bold one; others recede as ambient context. Opacities
              brought down ~20% so the chart reads as a present-but-
              secondary layer behind the UI, not a competing element. */}
          {[40, 80, 120, 160, 200].map((r, i) => (
            <circle
              key={r}
              cx={250} cy={250} r={r}
              fill="none"
              stroke={`rgba(200,144,42,${0.28 - i * 0.04})`}
              strokeWidth={1}
            />
          ))}
          <circle cx={250} cy={250} r={180} fill="none" stroke="rgba(200,144,42,0.34)" strokeWidth={1.2} />

          {/* Tick marks every 15° on the scope ring — longer at
              cardinals/intercardinals (every 45°). Reads as a
              calibrated bezel. */}
          {Array.from({ length: 24 }, (_, i) => i * 15).map(deg => {
            const rad = (deg * Math.PI) / 180
            const isMajor = deg % 45 === 0
            const r1 = 180
            const r2 = 180 - (isMajor ? 10 : 5)
            return (
              <line
                key={`tick-${deg}`}
                x1={250 + r1 * Math.cos(rad)} y1={250 - r1 * Math.sin(rad)}
                x2={250 + r2 * Math.cos(rad)} y2={250 - r2 * Math.sin(rad)}
                stroke={`rgba(200,144,42,${isMajor ? 0.38 : 0.2})`}
                strokeWidth={isMajor ? 1.1 : 0.7}
              />
            )
          })}

          {/* Degree labels — cardinals + intercardinals, mono for that
              instrument-panel feel. Positioned just outside r=200 so
              they sit in the brighter outer zone of the dim vignette. */}
          {[
            { deg: 90, x: 250, y: 26, anchor: 'middle' as const },
            { deg: 45, x: 420, y: 86, anchor: 'middle' as const },
            { deg: 0, x: 478, y: 254, anchor: 'end' as const },
            { deg: 315, x: 420, y: 422, anchor: 'middle' as const },
            { deg: 270, x: 250, y: 480, anchor: 'middle' as const },
            { deg: 225, x: 80, y: 422, anchor: 'middle' as const },
            { deg: 180, x: 24, y: 254, anchor: 'start' as const },
            { deg: 135, x: 80, y: 86, anchor: 'middle' as const },
          ].map(({ deg, x, y, anchor }) => (
            <text
              key={`label-${deg}`}
              x={x} y={y}
              textAnchor={anchor}
              fill={`rgba(200,144,42,${deg % 90 === 0 ? 0.38 : 0.26})`}
              fontSize={10.5}
              letterSpacing="1"
              fontFamily="ui-monospace, 'SF Mono', monospace"
            >{deg}°</text>
          ))}

          {/* Eccentricity annotation on the scope ring — tiny label
              near the top tick, naming what the bold ring represents. */}
          <text
            x={258} y={68}
            fill="rgba(200,144,42,0.28)"
            fontSize={8}
            letterSpacing="2"
            fontFamily="ui-monospace, 'SF Mono', monospace"
          >60° ECC</text>

          {/* Dim radial vignette — drawn AFTER all the chart strokes so
              it tones them down where the UI card lives, but BEFORE the
              animated stimuli so those stay crisp. */}
          <circle cx={250} cy={250} r={250} fill="url(#dim)" />

          {/* Animated stimulus — varies by test type */}
          {testMode === 'goldmann' && (() => {
            // Kinetic perimetry: dots move inward along meridians. Normal is
            // the shorter Goldmann pace; slow preserves the older long pace.
            const cycleDur = speedMode === 'slow' ? 12 : 6
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
                    values="0;0.35;0.35;0;0" keyTimes="0;0.02;0.28;0.33;1" />
                </circle>
              )
            })
          })()}

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
                  values="0;0;0.45;0.45;0;0" keyTimes="0;0.05;0.08;0.16;0.2;1" />
              </circle>
            )
          })}

          {/* Fixation point with pulse */}
          <circle cx={250} cy={250} r={5} fill="#c8902a" opacity={0.28}>
            <animate attributeName="r" values="4;7;4" dur="4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.18;0.32;0.18" dur="4s" repeatCount="indefinite" />
          </circle>
        </svg>
      </div>

      {/* ── Top-right GitHub link — absolute positioned so it scrolls
            away with the page content rather than hovering on every screen. */}
      {HAS_GITHUB_LINK && (
        <header aria-label="Project links" className="absolute top-4 right-4 z-20">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener"
            aria-label="View source on GitHub"
            className="text-zinc-600 hover:text-zinc-300 transition-colors"
          >
            <svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          </a>
        </header>
      )}

      {/* ── Content ── */}
      <main className="relative z-10 max-w-md w-full px-6 py-10 space-y-7 text-center">
        {/* Specimen label — sits above the brand like a clinical card
            header. Hairlines with a tiny diamond ornament echo the
            calibration-target aesthetic of the perimetry chart behind it,
            and folds the domain into the header so it doesn't read as
            standalone debug info. */}
        <div className="fade-up fade-up-1 pt-4">
          <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-white/8 bg-black/20 px-3 py-1 text-[11px] font-medium text-zinc-300">
            <span>{APP_NAME}</span>
            <span aria-hidden="true" className="text-zinc-500">•</span>
            <span className="text-zinc-400">{APP_DOMAIN}</span>
          </p>
        </div>

        {/* Brand — at the fixation point of the chart */}
        <div className="fade-up fade-up-2 pb-2">
          <h1 className="min-h-[5.5rem] sm:min-h-[6.5rem] flex flex-col items-center justify-center">
            <span className="text-5xl sm:text-6xl font-heading font-extrabold tracking-tight text-white leading-[0.95]">
              {testMode === 'static' ? 'Static' : 'Goldmann'}
            </span>
            <span className="block text-accent text-xl sm:text-2xl tracking-[0.08em] uppercase font-heading font-bold mt-1">
              Visual Field
            </span>
          </h1>
        </div>

        <p className="fade-up fade-up-2 text-zinc-300 text-base max-w-sm mx-auto min-h-[2.5rem] flex items-center justify-center -mt-2 leading-relaxed">
          <span>
            {testMode === 'static'
              ? 'HFA-style static field self-check'
              : <>Kinetic perimetry self-check for <abbr title="Retinitis Pigmentosa" className="no-underline">RP</abbr></>}
          </span>
        </p>

        {/* ── Build-your-test card ──
            Single compact container holding eye selection, test mode, and
            speed toggle. Previously split into three numbered "steps" with
            separate headers, which worked as a legend but stacked visually
            heavy and pushed the Start CTA below the fold on small laptops.
            Combining into one card:
              - reduces perceived density without losing the per-section
                affordances,
              - lets selection state carry the step-indicator load (the
                picked eye + picked mode tell you what's selected without
                needing the "1 / 2" numerals),
              - frees space for a compact inline speed pill beside the
                mode tabs instead of a full-width bar competing with the
                Start button below.
            The eye buttons are SELECTORS, not immediate-action CTAs — an
            earlier version made each eye button start the test directly,
            but first-time users (incl. the author's wife) looked for a
            "Start" button. */}
        <div className="fade-up fade-up-3">
          {/* Outer relative wrapper carries the registration-mark
              corners as SIBLINGS of the card, not children. Earlier
              placement inside the card meant they were subject to
              `space-y-4` selector margin and possible subpixel drift
              from the card's own border/padding interplay at the
              bottom corners. Now: the wrapper's bounds exactly equal
              the card's border-box (card is the wrapper's only real
              child), and each bracket's -top-px -left-px offset pins
              its outer corner to the wrapper's edge with no layout
              interference. `backdrop-blur` removed from the card — the
              bolder chart behind it deserves to show through crisply.
              Card border upgraded to accent/20 so the corner brackets
              feel like extensions of the card's own rim. */}
          <div className="relative">
            <div className="bg-[#0b0b12]/80 border border-white/10 rounded-[20px] p-5 space-y-4 shadow-[0_18px_60px_rgba(0,0,0,0.45)]">

            {/* Card header — accessibility: earlier draft used zinc-500
                mono + 0.1em tracking for the duration, which sat
                directly on top of the scope-ring tick marks once the
                chart bezel got louder. Low-contrast grey + patterned
                background is a bad combination for RP users. Bumped
                both to zinc-200, dropped extra tracking on the
                duration, and gave the duration a subtle dark chip
                backing so it stays legible over the amber ticks. */}
            <div className="flex items-center justify-between gap-3 px-1">
              <p className="text-zinc-100 text-[11px] font-medium uppercase tracking-[0.12em]">
                Build your test
              </p>
              <p className="shrink-0 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[12px] font-medium text-zinc-100">
                {durationSelected}
              </p>
            </div>

            {/* Eye selection */}
            <div className="grid grid-cols-[1fr_1.15fr_1fr] gap-2" role="radiogroup" aria-label="Select eye">
              <button
                onClick={() => setEye('left')}
                role="radio"
                aria-checked={eye === 'left'}
                aria-label="Left eye (OS)"
                className={`group relative py-4 min-h-[84px] rounded-xl font-medium transition-colors duration-200 border focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base ${
                  eye === 'left'
                    ? 'bg-accent/18 border-accent/60'
                    : 'bg-white/[0.03] border-white/[0.08] hover:border-accent/25 hover:bg-white/[0.05]'
                }`}
              >
                <svg viewBox="0 0 32 32" className={`w-7 h-7 mx-auto mb-1.5 transition-colors duration-200 ${eye === 'left' ? 'text-accent' : 'text-zinc-500 group-hover:text-accent/80'}`} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                  <ellipse cx="16" cy="16" rx="13" ry="8" />
                  <circle cx="14" cy="16" r="5" />
                  <circle cx="13" cy="15.5" r="2" fill="currentColor" />
                </svg>
                <span className="block text-base font-heading font-semibold text-white">Left</span>
                <span className="text-zinc-400 text-[12px]"><abbr title="Oculus Sinister">OS</abbr></span>
              </button>

              <button
                onClick={() => setEye('both')}
                role="radio"
                aria-checked={eye === 'both'}
                aria-label="Both eyes (OU)"
                className={`group relative py-4 min-h-[84px] rounded-xl font-medium transition-colors duration-200 border focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base ${
                  eye === 'both'
                    ? 'bg-accent/18 border-accent/60'
                    : 'bg-white/[0.03] border-white/[0.08] hover:border-accent/25 hover:bg-white/[0.05]'
                }`}
              >
                <svg viewBox="0 0 40 32" className={`w-9 h-7 mx-auto mb-1.5 transition-colors duration-200 ${eye === 'both' ? 'text-accent' : 'text-zinc-500 group-hover:text-accent/80'}`} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                  <ellipse cx="13" cy="16" rx="10" ry="7" />
                  <circle cx="11.5" cy="16" r="3.5" />
                  <circle cx="11" cy="15.5" r="1.5" fill="currentColor" />
                  <ellipse cx="27" cy="16" rx="10" ry="7" />
                  <circle cx="28.5" cy="16" r="3.5" />
                  <circle cx="29" cy="15.5" r="1.5" fill="currentColor" />
                </svg>
                <span className="block text-base font-heading font-semibold text-white">Both</span>
                <span className="text-zinc-400 text-[12px]"><abbr title="Oculus Uterque">OU</abbr></span>
              </button>

              <button
                onClick={() => setEye('right')}
                role="radio"
                aria-checked={eye === 'right'}
                aria-label="Right eye (OD)"
                className={`group relative py-4 min-h-[84px] rounded-xl font-medium transition-colors duration-200 border focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base ${
                  eye === 'right'
                    ? 'bg-accent/18 border-accent/60'
                    : 'bg-white/[0.03] border-white/[0.08] hover:border-accent/25 hover:bg-white/[0.05]'
                }`}
              >
                <svg viewBox="0 0 32 32" className={`w-7 h-7 mx-auto mb-1.5 transition-colors duration-200 ${eye === 'right' ? 'text-accent' : 'text-zinc-500 group-hover:text-accent/80'}`} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                  <ellipse cx="16" cy="16" rx="13" ry="8" />
                  <circle cx="18" cy="16" r="5" />
                  <circle cx="19" cy="15.5" r="2" fill="currentColor" />
                </svg>
                <span className="block text-base font-heading font-semibold text-white">Right</span>
                <span className="text-zinc-400 text-[12px]"><abbr title="Oculus Dexter">OD</abbr></span>
              </button>
            </div>

            <div className="border-t border-white/[0.08]" />

            {/* Test mode tabs + explicit speed behavior copy.
                The control still toggles timing presets, but the text
                now makes it clear that this affects test duration and
                confirmation repeats rather than just "animation speed". */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex gap-1" role="tablist" aria-label="Test mode">
                  {(['goldmann', 'static'] as const).map(mode => (
                    <button
                      key={mode}
                      onClick={() => {
                        if (!studyLocked) setTestMode(mode)
                      }}
                      role="tab"
                      disabled={studyLocked}
                      aria-selected={testMode === mode}
                      className={`relative min-h-[40px] px-4 pb-1.5 pt-2 text-sm font-medium transition-colors duration-200 ${
                        testMode === mode ? 'text-white' : studyLocked ? 'text-zinc-500' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {mode === 'goldmann' ? 'Goldmann' : 'Static'}
                      <span className={`absolute bottom-0.5 inset-x-3 h-[2px] rounded-full bg-accent transition-all duration-300 origin-center ${
                        testMode === mode ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0'
                      }`} />
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => {
                    if (!studyLocked) {
                      setSpeedMode(s => (s === 'slow' ? 'normal' : 'slow'))
                    }
                  }}
                  role="switch"
                  disabled={studyLocked}
                  aria-checked={speedMode === 'normal'}
                  className={`inline-flex items-center gap-1.5 self-start rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                    speedMode === 'normal'
                      ? 'bg-teal/15 border-teal/40 text-teal'
                      : studyLocked
                        ? 'bg-white/[0.03] border-white/[0.08] text-zinc-400'
                        : 'bg-white/[0.03] border-white/[0.08] text-zinc-300 hover:text-white hover:bg-white/[0.05]'
                  }`}
                  aria-label={
                    speedMode === 'slow'
                      ? 'Slow pace enabled — tap to switch to normal pace'
                      : 'Normal pace enabled — tap to switch to slow pace'
                  }
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  {speedMode === 'slow' ? 'Slow pace' : 'Normal pace'}
                </button>
              </div>

              {studyLocked && (
                <p className="text-left text-xs leading-relaxed text-teal">
                  Test type, pace, extended-field behavior, and advanced settings are locked by the active study profile.
                </p>
              )}
            </div>
	          </div>
	          </div>
	        </div>

        {/* ── Start test CTA ──
            The primary action button. Eye selection + test type + speed
            are configured above; this button actually launches the flow.
            Labelled explicitly so first-time visitors don't have to infer
            that tapping an eye starts a test. */}
        {/* Start CTA — the commit moment. Instead of a generic "Start
            test →", the button states exactly what's being committed to
            (eye · mode · duration) in a mono caps strip beneath the
            label. Reads as a countersigned instruction card rather than
            a generic submit button, and removes the user's need to
            glance back up at the card to verify the configuration. */}
        <div className="fade-up fade-up-4">
          <button
            onClick={() => startTest(eye)}
            disabled={!studyReady}
            className={`group w-full min-h-[60px] rounded-xl border py-4 text-white transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base ${
              studyReady
                ? 'border-accent/40 bg-accent shadow-[0_4px_24px_rgba(200,144,42,0.22)] hover:scale-[1.01] hover:bg-accent-light hover:shadow-[0_6px_32px_rgba(200,144,42,0.32)]'
                : 'border-white/10 bg-zinc-700 text-zinc-300 shadow-none'
            }`}
            aria-label={`Start test: ${testMode} on ${eye === 'both' ? 'both eyes' : eye + ' eye'}`}
          >
            <span className="flex items-center justify-center gap-2 text-base font-heading font-bold leading-none">
              Begin test
              <svg className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            {/* Config subtitle — accessibility note: this button is the
                commit moment for a low-vision user (RP). Earlier drafts
                used 9px + 0.3em tracking + 75% white, which looked
                refined but was genuinely hard to parse. Bumped to 11px,
                full-white, tighter tracking, and mixed case (casing
                preserves word-shape, which matters under reduced
                acuity). Dividers are 75% so they recede without
                bleaching. */}
            <span className="mt-1 block text-[12px] font-medium tracking-[0.02em] text-white/95">
              {eye === 'both' ? 'OU' : eye === 'left' ? 'OS' : 'OD'}
              <span className="mx-2 text-white/75">·</span>
              {testMode === 'goldmann' ? 'Goldmann' : 'Static'}
              <span className="mx-2 text-white/75">·</span>
              {durationSelected.replace('~', '')}
            </span>
          </button>
          {!studyReady && (
            <p className="mt-2 text-sm text-amber-200/85">
              Study mode requires both a participant ID and session ID before the test can start.
            </p>
          )}
        </div>


        {/* Quick actions row
            Signed-in users see a Results button here (opens history).
            Anonymous users see an account-creation prompt — most first-
            time visitors don't have an account, so the primary CTA is
            "Create account" and "Sign in" is a secondary link below
            (Dropbox/Notion-style). Both open the same AuthModal, just
            starting on different tabs. */}
        {user ? (
          <div className="fade-up fade-up-6 flex gap-3">
            <button
              onClick={() => setPage('history')}
              className="flex-1 py-3 min-h-[48px] bg-white/[0.03] hover:bg-white/[0.06] rounded-xl font-medium transition-all border border-white/[0.06] hover:border-white/[0.12] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base"
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M12 8v4l3 3" />
                <circle cx="12" cy="12" r="10" />
              </svg>
              Results
              {resultCount > 0 && (
                <span className="ml-1.5 text-zinc-500 text-sm">({resultCount})</span>
              )}
            </button>
          </div>
        ) : (
          <div className="fade-up fade-up-6 space-y-2">
            <button
              onClick={() => { setAuthMode('register'); setShowAuth(true) }}
              className="w-full py-3 min-h-[48px] bg-white/[0.03] hover:bg-white/[0.06] rounded-xl text-sm font-medium text-zinc-100 hover:text-white transition-all border border-white/[0.08] hover:border-white/[0.14] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base"
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              Create account
            </button>
            <p className="text-center text-sm text-zinc-300">
              Already have an account?{' '}
              <button
                onClick={() => { setAuthMode('login'); setShowAuth(true) }}
                className="min-h-[44px] px-1 text-accent hover:text-accent-light"
              >
                Sign in
              </button>
            </p>
          </div>
        )}

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
            {canUseStudyMode && (
              <button
                onClick={() => setPage('clinician')}
                className="text-accent hover:text-accent-light transition-colors min-h-[44px] px-2"
              >
                Clinician portal
              </button>
            )}
            <button
              onClick={logout}
              className="text-zinc-500 hover:text-zinc-300 transition-colors min-h-[44px] px-2"
            >
              Sign out
            </button>
            <button
              onClick={() => { setShowDeleteAccount(true); setDeleteAccountTyped(''); setDeleteAccountError(null) }}
              className="text-red-500/70 hover:text-red-400 transition-colors min-h-[44px] px-2"
            >
              Delete account
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
            <button onClick={() => setPage('contact')} className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-1">Contact</button>
            <button onClick={() => setPage('privacy')} className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-1">Privacy</button>
          </div>
          <div className="flex justify-center gap-3 pt-2">
            <a
              href={whatsappShareUrl()}
              onClick={() => {
                trackEvent('whatsapp_shared', getDeviceId(), { source: 'home_footer' }).catch(() => {})
              }}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1.5 text-zinc-500 hover:text-green-400 text-xs transition-colors min-h-[44px] px-1"
            >
              <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
              </svg>
              Share
            </a>
            {HAS_GITHUB_LINK && (
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-1"
              >
                <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden="true">
                  <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                </svg>
                GitHub
              </a>
            )}
          </div>
        </nav>

      </main>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} initialMode={authMode} />}

      {showDeleteAccount && user && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-title"
          onClick={closeDeleteAccountModal}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-red-900/50 bg-gray-950 p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 id="delete-account-title" className="text-lg font-semibold text-white">Delete your account</h2>
            <p className="mt-3 text-sm text-zinc-300">
              This will permanently delete your account ({user.email}) and all your test results, surveys, saved screens, and active sessions. This cannot be undone.
            </p>
            <p className="mt-4 text-xs text-zinc-400">
              Type your name (<span className="font-mono text-zinc-200">{user.displayName}</span>) to confirm:
            </p>
            <input
              type="text"
              autoFocus
              value={deleteAccountTyped}
              onChange={e => setDeleteAccountTyped(e.target.value)}
              className="mt-2 w-full rounded-lg border border-zinc-800/60 bg-zinc-900/80 px-3 py-2 text-sm text-white focus:border-red-500/60 focus:outline-none"
              placeholder={user.displayName}
              disabled={deleteAccountBusy}
            />
            {deleteAccountError && (
              <p className="mt-3 rounded-lg border border-red-800/40 bg-red-900/20 px-3 py-2 text-sm text-red-300">
                {deleteAccountError}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={deleteAccountBusy}
                onClick={closeDeleteAccountModal}
              >
                Cancel
              </button>
              <button
                className="rounded-lg border border-red-700 bg-red-700/40 px-4 py-2 text-sm font-medium text-red-100 hover:bg-red-700/60 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={deleteAccountTyped.trim() !== user.displayName || deleteAccountBusy}
                onClick={() => void confirmDeleteOwnAccount()}
              >
                {deleteAccountBusy ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
