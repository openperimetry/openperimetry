import { useEffect, useState } from 'react'
import type { CalibrationData, Eye, PresentationMode, TestPoint } from './types'
import { isPhoneLikeDevice } from './deviceMode'
import { CalibrationScreen } from './components/CalibrationScreen'
import { GoldmannTest, type SpeedMode } from './components/GoldmannTest'
import { StaticTest } from './components/StaticTest'
import { TestDemo } from './components/TestDemo'
import { DemoResult } from './components/DemoResult'
import { BinocularResults } from './components/BinocularResults'
import { BinocularSwitch } from './components/BinocularSwitch'
import { InfoButton } from './components/InfoButton'
import { HistoryView } from './components/HistoryView'
import { ScienceReferences } from './components/ScienceReferences'
import { MethodsPage } from './components/MethodsPage'
import { ContactPage } from './components/ContactPage'
import { PrivacyPage } from './components/PrivacyPage'
import { AdminPage } from './components/AdminPage'
import { AuthModal } from './components/AuthModal'
import { ClinicalDisclaimer } from './components/ClinicalDisclaimer'
import { ClinicianPortal } from './components/ClinicianPortal'
import { CliniciansPage } from './components/CliniciansPage'
import { ThemeToggle } from './components/ThemeToggle'
import { useAuth } from './AuthContext'
import { ADVANCED_SETTINGS_CTX, type AdvancedSettings } from './advancedSettings'
import type { ReactNode } from 'react'
import { getDeviceId, getResults } from './storage'
import { APP_NAME, APP_TAGLINE, TITLE_SUFFIX, GITHUB_URL, HAS_GITHUB_LINK, whatsappShareUrl } from './branding'
import { trackEvent } from './api'
import { DEFAULT_STUDY_MODE_STATE, isStudyReady, useSetStudyMode, useStudyMode } from './studyMode'
import { DEMO_HASH, splitHash, demoHash, demoTargetFromHash, type DemoMode } from './demoRoute'

type Page = 'home' | 'calibration' | 'test' | 'static-test' | 'binocular-switch' | 'binocular-test-left' | 'binocular-results' | 'history' | 'demo' | 'science' | 'methods' | 'contact' | 'privacy' | 'admin' | 'clinician' | 'clinicians'
type TestMode = 'goldmann' | 'static'

const HASH_ROUTES: Partial<Record<Page, string>> = {
  home: '',
  demo: DEMO_HASH,
  science: 'references',
  methods: 'methods',
  contact: 'contact',
  privacy: 'privacy',
  clinicians: 'clinicians',
}

const PAGE_BY_HASH: Record<string, Page> = Object.entries(HASH_ROUTES).reduce<Record<string, Page>>(
  (acc, [page, hash]) => {
    acc[hash] = page as Page
    return acc
  },
  {},
)

function pageFromHash(): Page {
  if (typeof window === 'undefined') return 'home'
  const { head } = splitHash(window.location.hash)
  return PAGE_BY_HASH[head] ?? 'home'
}

function urlForPage(page: Page, demoScenarioId?: string | null, demoMode: DemoMode = 'goldmann'): string | null {
  if (typeof window === 'undefined') return null
  if (!(page in HASH_ROUTES)) return null
  const hash = page === 'demo' ? demoHash(demoScenarioId ?? null, demoMode) : HASH_ROUTES[page]
  return `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ''}`
}

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
  clinicians: `For clinicians${TITLE_SUFFIX}`,
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

/**
 * Compact, friendly preview of what the chosen test will ask you to
 * do. Renders the same motion the test actually uses — a dot drifting
 * inward from the edge for Goldmann, dots quietly blinking on for
 * Static — so the plain-language explanation has a calm visual to go
 * with it.
 *
 * Deliberately NOT an instrument scope: an earlier version was a dark
 * radar-style display with a tick-marked bezel and meridian grid,
 * which made the home page read as a piece of lab equipment rather
 * than a reassuring at-home check. This version drops the black
 * background, the ticks and the meridian lines, keeps a couple of
 * soft guide rings on a light tint, and pairs the animation with a
 * one-line caption in everyday words.
 */
function PerimetryPreview({ testMode, speedMode }: { testMode: TestMode; speedMode: SpeedMode }) {
  const caption = testMode === 'goldmann'
    ? 'A dot drifts in from the edge — you press the moment you notice it.'
    : 'Small dots blink on here and there — you press each time you spot one.'
  return (
    <div className="rounded-2xl border border-line bg-gradient-to-b from-accent-tint to-surface overflow-hidden">
      <svg viewBox="0 0 500 500" className="block mx-auto w-auto max-h-[116px]" aria-hidden="true">
        {/* A couple of soft guide rings — enough to read as "your field
            of view", without the tick-marked scope bezel that made the
            old version feel like lab equipment. */}
        {[70, 130, 190].map((r, i) => (
          <circle
            key={r}
            cx={250} cy={250} r={r}
            fill="none"
            stroke={`rgba(10,108,201,${0.16 - i * 0.04})`}
            strokeWidth={1.5}
          />
        ))}

        {/* Animated stimulus — varies by test type */}
        {testMode === 'goldmann' && (() => {
          // Kinetic perimetry: dots move inward along meridians.
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
            const sx = Math.round(250 + 205 * cos)
            const sy = Math.round(250 - 205 * sin)
            const ex = Math.round(250 + 38 * cos)
            const ey = Math.round(250 - 38 * sin)
            return (
              // Base cx/cy/opacity must be set: SMIL falls back to
              // attribute defaults before `begin`, parking delayed
              // dots at the top-left corner otherwise.
              <circle key={`g-${angle}-${cycleDur}`} cx={sx} cy={sy} r={8} fill="#0a6cc9" opacity={0}>
                <animate attributeName="cx" dur={`${cycleDur}s`} repeatCount="indefinite" begin={`${delay}s`}
                  values={`${sx};${sx};${ex};${ex};${ex}`} keyTimes="0;0.02;0.3;0.33;1" />
                <animate attributeName="cy" dur={`${cycleDur}s`} repeatCount="indefinite" begin={`${delay}s`}
                  values={`${sy};${sy};${ey};${ey};${ey}`} keyTimes="0;0.02;0.3;0.33;1" />
                <animate attributeName="opacity" dur={`${cycleDur}s`} repeatCount="indefinite" begin={`${delay}s`}
                  values="0;0.9;0.9;0;0" keyTimes="0;0.02;0.28;0.33;1" />
              </circle>
            )
          })
        })()}

        {testMode === 'static' && [
          // Static perimetry: dots flash briefly at scattered positions
          { angle: 35, ecc: 75, delay: 0 },
          { angle: 110, ecc: 135, delay: 0.6 },
          { angle: 200, ecc: 95, delay: 1.2 },
          { angle: 305, ecc: 165, delay: 1.8 },
          { angle: 70, ecc: 185, delay: 2.4 },
          { angle: 240, ecc: 55, delay: 3.0 },
          { angle: 150, ecc: 190, delay: 3.6 },
          { angle: 350, ecc: 115, delay: 4.2 },
        ].map(({ angle, ecc, delay }) => {
          const rad = (angle * Math.PI) / 180
          const cx = Math.round(250 + ecc * Math.cos(rad))
          const cy = Math.round(250 - ecc * Math.sin(rad))
          return (
            <circle key={`s-${angle}-${ecc}`} cx={cx} cy={cy} r={8} fill="#0a6cc9" opacity={0}>
              <animate attributeName="opacity" dur="5s" repeatCount="indefinite" begin={`${delay}s`}
                values="0;0;0.9;0.9;0;0" keyTimes="0;0.05;0.08;0.16;0.2;1" />
            </circle>
          )
        })}

        {/* Fixation point — the spot you keep your eye on. Gentle pulse
            so it reads as "look here", not a blip on a radar. */}
        <circle cx={250} cy={250} r={7} fill="#0a6cc9" opacity={0.5}>
          <animate attributeName="r" values="6;10;6" dur="4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.4;0.65;0.4" dur="4s" repeatCount="indefinite" />
        </circle>
      </svg>
      {/* Plain-language caption so the preview explains itself rather
          than leaving the motion to be decoded. */}
      <p className="px-4 pb-3 -mt-1 text-center text-[12px] leading-snug text-muted">
        {caption}
      </p>
    </div>
  )
}

function durationFor(testMode: TestMode, speedMode: SpeedMode, binocular: boolean): string {
  if (testMode === 'goldmann') {
    if (speedMode === 'quick') return binocular ? '~2 min' : '~1 min'
    if (speedMode === 'slow') return binocular ? '~30 min' : '~15 min'
    return binocular ? '~10 min' : '~5 min'
  }
  // Static. Quick = 10-2 grid (central ±9°, 68 points but only the
  // inner ones at standard staircase tempo — roughly half the time
  // of a 24-2 normal run because most locations converge fast on a
  // healthy macula).
  if (speedMode === 'quick') return binocular ? '~6–8 min' : '~3–4 min'
  if (speedMode === 'slow') return binocular ? '~28–36 min' : '~14–18 min'
  return binocular ? '~14–20 min' : '~7–10 min'
}

function App() {
  const [page, setPage] = useState<Page>(() => pageFromHash())
  const [demoScenarioId, setDemoScenarioId] = useState<string | null>(() =>
    typeof window !== 'undefined' ? demoTargetFromHash(window.location.hash).id : null,
  )
  const [demoMode, setDemoMode] = useState<DemoMode>(() =>
    typeof window !== 'undefined' ? demoTargetFromHash(window.location.hash).mode : 'goldmann',
  )
  const [eye, setEye] = useState<Eye>('right')
  const [calibration, setCalibration] = useState<CalibrationData | null>(null)
  const [extendedField, setExtendedField] = useState(false)
  // Home picker — the user's personal-test preferences. Persisted to
  // localStorage so they survive reloads. Never mutated by the
  // clinician portal; study runs build their own runConfig instead.
  const [testMode, setTestMode] = useState<TestMode>(() => loadHomeTestMode())
  const [speedMode, setSpeedMode] = useState<SpeedMode>(() => loadHomeSpeedMode())
  // Presentation mode always starts on `standard`, even on a phone — Phone VR
  // is an explicit per-session opt-in via the home control, never a remembered
  // default, so the headset path is never entered without the user choosing it.
  const [presentationMode, setPresentationMode] = useState<PresentationMode>('standard')
  // Phone detection is stable for a session; computed once so the home
  // control and the launch path agree on whether Phone VR is allowed.
  const phoneLike = isPhoneLikeDevice()
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
    presentationMode: PresentationMode
    advancedOverride: AdvancedSettings | null
  }>({ testMode: 'goldmann', speedMode: 'normal', presentationMode: 'standard', advancedOverride: null })

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

  useEffect(() => {
    const handleLocationChange = () => {
      setPage(pageFromHash())
      const t = demoTargetFromHash(window.location.hash)
      setDemoScenarioId(t.id)
      setDemoMode(t.mode)
    }
    window.addEventListener('hashchange', handleLocationChange)
    window.addEventListener('popstate', handleLocationChange)
    return () => {
      window.removeEventListener('hashchange', handleLocationChange)
      window.removeEventListener('popstate', handleLocationChange)
    }
  }, [])

  useEffect(() => {
    const nextUrl = urlForPage(page, demoScenarioId, demoMode)
    if (nextUrl) {
      const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
      if (currentUrl !== nextUrl) {
        window.history.pushState(null, '', nextUrl)
      }
      return
    }

    if (window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }
  }, [page, demoScenarioId, demoMode])

  // Update document title on page change and send a virtual pageview to
  // Umami. This is still a client-rendered SPA; hash URLs make public
  // pages shareable, while this call keeps analytics labels explicit.
  useEffect(() => {
    document.title = PAGE_TITLES[page]
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
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
      setRunConfig({ testMode: devMode as TestMode, speedMode: 'normal', presentationMode: 'standard', advancedOverride: null })
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
    // Never launch a phone-vr run on a non-phone device, even if a stale
    // preference says phone-vr — the option is gated on the home control,
    // and this is the second guard at the actual launch point.
    setRunConfig({
      testMode,
      speedMode,
      presentationMode: phoneLike ? presentationMode : 'standard',
      advancedOverride: null,
    })
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
      // Clinician/study runs stay standard for now — no study profile
      // declares headset support yet.
      presentationMode: 'standard',
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

  // The auth modal normally lives only in the home return below, but the
  // in-test results screens dispatch `vfc:show-auth` too (SavePrompt's "Sign
  // in" / "Create account" buttons) — and App returns those screens early,
  // before ever reaching the home render. Without overlaying the modal on
  // those returns, clicking the buttons set `showAuth` but nothing appears.
  const authModal = showAuth ? (
    <AuthModal onClose={() => setShowAuth(false)} initialMode={authMode} />
  ) : null

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
          speedMode={runConfig.speedMode}
          presentationMode={runConfig.presentationMode}
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
        {authModal}
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
        {authModal}
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

  // Binocular: switch eyes interstitial. In phone-VR this is hands-free
  // (remote + countdown) so the phone never leaves the headset; standard
  // mode keeps the cover-and-reposition instructions with tap buttons.
  if (page === 'binocular-switch') {
    return (
      <BinocularSwitch
        presentationMode={runConfig.presentationMode}
        onContinue={() => setPage('binocular-test-left')}
        onSkip={() => {
          setLeftPoints([])
          setPage('binocular-results')
        }}
      />
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
        {authModal}
      </RunAdvancedBoundary>
    )
  }

  if (page === 'history') {
    return <HistoryView onBack={() => setPage('home')} />
  }

  if (page === 'demo') {
    return demoScenarioId
      ? (
        <DemoResult
          scenarioId={demoScenarioId}
          mode={demoMode}
          onBack={() => { setDemoScenarioId(null); setDemoMode('goldmann') }}
          onNavigate={(id, m) => { setDemoScenarioId(id); setDemoMode(m) }}
        />
      )
      : (
        <TestDemo
          onBack={() => setPage('home')}
          onSelectScenario={(id) => { setDemoScenarioId(id); setDemoMode('goldmann') }}
        />
      )
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

  if (page === 'clinicians') {
    return (
      <CliniciansPage
        onBack={() => setPage('home')}
        onContact={() => setPage('contact')}
      />
    )
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
      <div className="min-h-[100dvh] bg-base text-body safe-pad p-6 animate-page-in">
        <main className="mx-auto max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-heading font-bold">Clinician access required</h1>
          <p className="text-sm text-muted">Sign in with a clinician account to manage participants and protocols.</p>
          <button onClick={() => setPage('home')} className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-dark transition-colors">
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
    <div className="min-h-[100dvh] bg-base text-body flex flex-col items-center justify-center relative overflow-hidden safe-pad">
      {/* ── Top-right controls — theme toggle + GitHub link. Absolute so they
            scroll away with the page rather than hovering on every screen. */}
      <header aria-label="Site controls" className="absolute top-4 right-4 z-20 flex items-center gap-1">
        <ThemeToggle />
        {HAS_GITHUB_LINK && (
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener"
            aria-label="View source on GitHub"
            className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-muted hover:text-ink transition-colors"
          >
            <svg viewBox="0 0 24 24" width={22} height={22} fill="currentColor" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          </a>
        )}
      </header>

      {/* ── Content ── */}
      <main className="relative z-10 max-w-md w-full px-6 py-10 space-y-7 text-center">
        {/* Brand — at the fixation point of the chart. Two-line H1:
            big bold APP_NAME (whatever the deployment is branded as)
            + smaller tracked gold "Visual Field Check" descriptor.
            Previously this line was the test-mode label ("Goldmann"
            vs "Static"), which made the home page feel like it
            shifted brand identity every time you toggled the tabs.
            The brand is the app, not the test mode — the test mode
            is selected inside the build-your-test card below.

            The gold "Visual Field Check" descriptor is suppressed
            when APP_NAME already contains "visual field" (e.g. a
            "Visual Field Check" / "VisualFieldCheck" branded
            deployment) — otherwise the title reads as the same
            phrase twice. Detection is whitespace- and
            case-insensitive so variants like "VisualFieldCheck"
            also collapse correctly. */}
        <div className="fade-up fade-up-2 pb-2">
          {(() => {
            const brandHasVisualField = APP_NAME.replace(/\s+/g, '').toLowerCase().includes('visualfield')
            return (
              <h1
                className={
                  brandHasVisualField
                    ? 'min-h-[5rem] sm:min-h-[6rem] flex items-center justify-center'
                    : 'min-h-[5.5rem] sm:min-h-[6.5rem] flex flex-col items-center justify-center'
                }
              >
                <span className="text-5xl sm:text-6xl font-heading font-extrabold tracking-tight text-ink leading-[0.95]">
                  {APP_NAME}
                </span>
                {!brandHasVisualField && (
                  <span className="block text-accent text-xl sm:text-2xl tracking-[0.08em] uppercase font-heading font-bold mt-1">
                    Visual Field Check
                  </span>
                )}
              </h1>
            )
          })()}
          {/* Plain-language value prop — a name is not a reason. This one
              line tells a first-time visitor what the test is, where it
              happens, and roughly how long, so they can decide to start
              without inferring purpose from the brand alone. Kept high-
              contrast (zinc-200) and at a legible size for the low-vision
              audience this tool serves. */}
          <p className="mt-2 mx-auto max-w-md text-center text-[15px] leading-relaxed text-body">
            Check your vision at home in about 5–15 minutes, for free.
          </p>
        </div>

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
            {/* Clean white "build your test" panel. The earlier draft wrapped
                this in gold scope-bezel rings and a 24-tick instrument bezel,
                which read as an intimidating instrument rather than a calm
                clinical tool. The single instrument reference we keep is the
                live PerimetryPreview chart inside the card. */}
            <div className="relative z-[2] card rounded-3xl p-5 space-y-4">

            {/* Card header — accessibility: earlier draft used zinc-500
                mono + 0.1em tracking for the duration, which sat
                directly on top of the scope-ring tick marks once the
                chart bezel got louder. Low-contrast grey + patterned
                background is a bad combination for RP users. Bumped
                both to zinc-200, dropped extra tracking on the
                duration, and gave the duration a subtle dark chip
                backing so it stays legible over the amber ticks. */}
            <div className="flex items-center justify-between gap-3 px-1">
              <p className="text-ink text-[15px] font-heading font-semibold">
                Set up your test
              </p>
              <p className="tnum shrink-0 rounded-md border border-line bg-subtle px-2 py-1 text-[12px] font-medium text-body">
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
                    ? 'bg-accent-tint border-accent'
                    : 'bg-surface border-line hover:border-accent/50 hover:bg-subtle'
                }`}
              >
                <svg viewBox="0 0 32 32" className={`w-7 h-7 mx-auto mb-1.5 transition-colors duration-200 ${eye === 'left' ? 'text-accent' : 'text-muted group-hover:text-accent'}`} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                  <ellipse cx="16" cy="16" rx="13" ry="8" />
                  <circle cx="14" cy="16" r="5" />
                  <circle cx="13" cy="15.5" r="2" fill="currentColor" />
                </svg>
                <span className="block text-base font-heading font-semibold text-ink">Left</span>
                <span className="text-muted text-[12px]"><abbr title="Oculus Sinister">OS</abbr></span>
              </button>

              <button
                onClick={() => setEye('both')}
                role="radio"
                aria-checked={eye === 'both'}
                aria-label="Both eyes (OU)"
                className={`group relative py-4 min-h-[84px] rounded-xl font-medium transition-colors duration-200 border focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base ${
                  eye === 'both'
                    ? 'bg-accent-tint border-accent'
                    : 'bg-surface border-line hover:border-accent/50 hover:bg-subtle'
                }`}
              >
                <svg viewBox="0 0 40 32" className={`w-9 h-7 mx-auto mb-1.5 transition-colors duration-200 ${eye === 'both' ? 'text-accent' : 'text-muted group-hover:text-accent'}`} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                  <ellipse cx="13" cy="16" rx="10" ry="7" />
                  <circle cx="11.5" cy="16" r="3.5" />
                  <circle cx="11" cy="15.5" r="1.5" fill="currentColor" />
                  <ellipse cx="27" cy="16" rx="10" ry="7" />
                  <circle cx="28.5" cy="16" r="3.5" />
                  <circle cx="29" cy="15.5" r="1.5" fill="currentColor" />
                </svg>
                <span className="block text-base font-heading font-semibold text-ink">Both</span>
                <span className="text-muted text-[12px]"><abbr title="Oculus Uterque">OU</abbr></span>
              </button>

              <button
                onClick={() => setEye('right')}
                role="radio"
                aria-checked={eye === 'right'}
                aria-label="Right eye (OD)"
                className={`group relative py-4 min-h-[84px] rounded-xl font-medium transition-colors duration-200 border focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base ${
                  eye === 'right'
                    ? 'bg-accent-tint border-accent'
                    : 'bg-surface border-line hover:border-accent/50 hover:bg-subtle'
                }`}
              >
                <svg viewBox="0 0 32 32" className={`w-7 h-7 mx-auto mb-1.5 transition-colors duration-200 ${eye === 'right' ? 'text-accent' : 'text-muted group-hover:text-accent'}`} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                  <ellipse cx="16" cy="16" rx="13" ry="8" />
                  <circle cx="18" cy="16" r="5" />
                  <circle cx="19" cy="15.5" r="2" fill="currentColor" />
                </svg>
                <span className="block text-base font-heading font-semibold text-ink">Right</span>
                <span className="text-muted text-[12px]"><abbr title="Oculus Dexter">OD</abbr></span>
              </button>
            </div>

            <div className="border-t border-line" />

            {/* Test mode tabs + explicit speed behavior copy.
                The control still toggles timing presets, but the text
                now makes it clear that this affects test duration and
                confirmation repeats rather than just "animation speed". */}
            <div className="space-y-3">
              {/* Tabs and pace pill always stack vertically. Both rows
                  picked up info-icon buttons after the layout was
                  last restored to side-by-side, and the combined
                  width of Goldmann/Static tabs + Q/N/S pill + their
                  info icons now overshoots the bezel card's inner
                  edge on viewports we actually ship to (a 20 px
                  overhang on ~800 px wide). Stacking always is the
                  simple, robust fix — costs one row of vertical
                  space, keeps every control firmly inside the
                  scope-bezel rim. */}
              {/* Both rows centred within the card. With the
                  always-stack layout, content was left-aligned and
                  felt off-axis against the symmetric scope-bezel
                  frame around it; centring puts the controls on the
                  same vertical midline as the eye-select cards
                  above and the preview chart below. */}
              <div className="flex flex-col gap-3 items-center">
                <div className="flex gap-3" role="tablist" aria-label="Test mode">
                  {(['goldmann', 'static'] as const).map(mode => (
                    <div key={mode} className="flex items-center">
                      <button
                        onClick={() => {
                          if (studyLocked) return
                          setTestMode(mode)
                          // Both test modes support 'quick' now (Goldmann
                          // quick = single III4e isopter; Static quick =
                          // 10-2 central grid), so no cross-mode reset
                          // is needed — the pace selection carries over
                          // and means a "shorter test" in both cases.
                        }}
                        role="tab"
                        disabled={studyLocked}
                        aria-selected={testMode === mode}
                        // Asymmetric horizontal padding (pl-4 pr-1) so the
                        // info icon sits visually attached to the label
                        // rather than detached at the far side of the
                        // tab's right padding. Underline below uses
                        // `inset-x-3` which still tracks the text
                        // closely enough that the small offset reads as
                        // intentional spacing.
                        className={`relative min-h-[40px] pl-4 pr-1 pb-1.5 pt-2 text-sm font-medium transition-colors duration-200 ${
                          testMode === mode ? 'text-ink' : studyLocked ? 'text-muted' : 'text-muted hover:text-ink'
                        }`}
                      >
                        {mode === 'goldmann' ? 'Goldmann' : 'Static'}
                        <span className={`absolute bottom-0.5 left-3 right-1 h-[2px] rounded-full bg-accent transition-all duration-300 origin-center ${
                          testMode === mode ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0'
                        }`} />
                      </button>
                      <InfoButton
                        label={mode === 'goldmann' ? 'Goldmann test' : 'Static test'}
                        className="mb-1.5"
                      >
                        {mode === 'goldmann' ? (
                          <>
                            <strong className="text-accent block mb-1">Goldmann (kinetic) perimetry</strong>
                            Moving stimuli sweep inward from the screen edge along meridians; you press the moment you see one. Maps the outer <em>boundary</em> of your visual field as isopters. Clinical standard for tracking peripheral field loss like retinitis pigmentosa.
                          </>
                        ) : (
                          <>
                            <strong className="text-accent block mb-1">Static (HFA-style) perimetry</strong>
                            Stimuli flash briefly at fixed grid locations; an adaptive 4-2 dB staircase finds your detection threshold at each. Produces a <em>sensitivity heatmap</em>. Standard for tracking glaucoma and macular disease.
                          </>
                        )}
                      </InfoButton>
                    </div>
                  ))}
                </div>

                {/* Pace picker. Both modes get three options now:
                    - Goldmann Quick: single III4e isopter (~1 min)
                    - Static Quick: 10-2 grid, central ±9° (~3-4 min)
                    Both Quick variants are scope-shrinks, not pacing
                    tweaks, and both are positioned as
                    "between-proper-exams checks". The remaining
                    Normal/Slow distinction is per-mode: kinetic
                    sweep speed for Goldmann; reversal count + per-
                    stim timing for Static. */}
                {(() => {
                  const options = ['quick', 'normal', 'slow'] as const
                  const labelFor = (m: typeof options[number]) =>
                    m === 'quick' ? 'Quick' : m === 'normal' ? 'Normal' : 'Slow'
                  // Pace info content varies by test mode — Quick /
                  // Normal / Slow mean different things in Goldmann
                  // (sweep speed + isopter count) vs Static (grid +
                  // staircase reversal count). The popover lists all
                  // three for the currently-selected mode so a user
                  // can browse before picking.
                  const paceInfoEntries = testMode === 'goldmann'
                    ? [
                        ['Quick', 'Single III4e isopter only (~1 min). The clinical reportable outer boundary — handy for serial monitoring between full tests.'],
                        ['Normal', 'Full battery (V4e + III4e + III2e + I4e + I2e) at standard sweep speed (~5 min). The default Goldmann test.'],
                        ['Slow', 'Full battery with slower sweeps and longer pre-stim delay (~15 min). More reaction time per sweep, fewer false negatives.'],
                      ] as const
                    : [
                        ['Quick', 'HFA 10-2 grid (central ±9°, ~3-4 min). Suited to tracking macular involvement. Not the right scan for RP peripheral monitoring.'],
                        ['Normal', '24-2 grid with 2 staircase reversals per location (~7-10 min). The default static threshold test.'],
                        ['Slow', '24-2 grid with 4 reversals + longer per-stim timing (~14-18 min). Lower threshold variance at the cost of duration.'],
                      ] as const
                  return (
                    // Outer rounded container groups the radio pills AND
                    // the info button as a single visual unit, so the (i)
                    // sits inside the same pill-background as the
                    // options it describes rather than floating off to
                    // the side and pushing past the card edge.
                    // `role="radiogroup"` lives on the inner pill row
                    // (containing only the three radios) so a11y stays
                    // strict — the info button is a sibling, not part
                    // of the radio group.
                    <div className="inline-flex items-center gap-1 rounded-full border border-line bg-subtle p-1">
                      <div
                        role="radiogroup"
                        aria-label="Test pace"
                        className="inline-flex gap-1"
                      >
                        {options.map(mode => {
                          const selected = speedMode === mode
                          return (
                            <button
                              key={mode}
                              role="radio"
                              disabled={studyLocked}
                              aria-checked={selected}
                              onClick={() => { if (!studyLocked) setSpeedMode(mode) }}
                              // Selected state uses the app's primary
                              // accent gold (matches the eye-selection
                              // card and Begin CTA) for palette
                              // consistency. The previous teal was the
                              // only teal on the home screen — recoloured
                              // so the pace pill belongs to the same
                              // visual system as the rest of the card.
                              className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                                selected
                                  ? 'bg-accent-tint text-accent'
                                  : studyLocked
                                    ? 'text-muted'
                                    : 'text-muted hover:text-ink hover:bg-subtle-2'
                              }`}
                            >
                              {labelFor(mode)}
                            </button>
                          )
                        })}
                      </div>
                      <InfoButton label="Test pace options" className="mr-1">
                        <strong className="text-accent block mb-2">Pace options</strong>
                        <div className="space-y-2">
                          {paceInfoEntries.map(([name, desc]) => (
                            <div key={name}>
                              <span className="text-white font-medium">{name}</span>
                              <span className="text-zinc-400"> — {desc}</span>
                            </div>
                          ))}
                        </div>
                      </InfoButton>
                    </div>
                  )
                })()}
              </div>

              {/* Preview chart — visual explanation of what the selected
                  test mode actually does. Sits as a full-width row
                  below the tabs+pill so the pill can sit next to the
                  tabs on desktop again. */}
              <PerimetryPreview testMode={testMode} speedMode={speedMode} />

              {/* Presentation mode — Standard vs Phone-in-headset (VR).
                  Phone VR cradles a phone in a passive headset, so the whole
                  control is shown only on a phone-like device; on desktop/
                  laptop/non-phone tablets it's hidden entirely. Also hidden
                  under a locked study profile, which always runs standard. */}
              {!studyLocked && phoneLike && (
                <div className="flex flex-col gap-2 items-center">
                  <div className="flex items-center gap-2">
                    <span className="text-muted text-[11px] font-semibold uppercase tracking-[0.12em]">Presentation</span>
                    <InfoButton label="Presentation mode">
                      <strong className="text-accent block mb-1">Phone VR mode</strong>
                      Mount your phone in landscape inside a passive VR headset. The screen splits into two lens halves and the tested eye uses one half.
                    </InfoButton>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="Presentation mode"
                    className="inline-flex gap-1 rounded-full border border-line bg-subtle p-1"
                  >
                    <button
                      role="radio"
                      aria-checked={presentationMode === 'standard'}
                      onClick={() => setPresentationMode('standard')}
                      className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                        presentationMode === 'standard'
                          ? 'bg-accent-tint text-accent'
                          : 'text-muted hover:text-ink hover:bg-subtle-2'
                      }`}
                    >
                      Standard
                    </button>
                    <button
                      role="radio"
                      aria-checked={presentationMode === 'phone-vr'}
                      onClick={() => setPresentationMode('phone-vr')}
                      className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                        presentationMode === 'phone-vr'
                          ? 'bg-accent-tint text-accent'
                          : 'text-muted hover:text-ink hover:bg-subtle-2'
                      }`}
                    >
                      Phone VR
                    </button>
                  </div>
                </div>
              )}

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
            className={`group w-full min-h-[60px] rounded-xl border py-4 transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base ${
              studyReady
                ? 'border-transparent bg-accent text-white shadow-[0_4px_24px_rgba(10,108,201,0.25)] hover:scale-[1.01] hover:bg-accent-dark hover:shadow-[0_6px_32px_rgba(10,108,201,0.32)]'
                : 'border-line bg-subtle-2 text-muted shadow-none'
            }`}
            aria-label={`Start test: ${testMode} on ${eye === 'both' ? 'both eyes, two separate tests' : eye + ' eye'}`}
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
            <span className="tnum mt-1 block text-[12px] font-medium tracking-[0.02em] text-white">
              {eye === 'both' ? 'Both eyes — 2 tests' : eye === 'left' ? 'Left eye' : 'Right eye'}
              <span className="mx-2 text-white/70">·</span>
              {testMode === 'goldmann' ? 'Goldmann' : 'Static'}
              {phoneLike && presentationMode === 'phone-vr' && (
                <>
                  <span className="mx-2 text-white/70">·</span>
                  Phone VR
                </>
              )}
              <span className="mx-2 text-white/70">·</span>
              {durationSelected.replace('~', '')}
            </span>
          </button>
          {/* Reassurance + expectations, directly under the commit moment.
              Placed BELOW the CTA so it never pushes Begin test off-screen,
              but close enough that a hesitant first-timer reads it before
              deciding. Answers the three things a cautious visitor wants to
              know at the button: is it safe to try (screening, not a
              diagnosis), is it low-commitment (no account), and what will it
              ask of me (so setup needs aren't a surprise only after Begin). */}
          <p className="mt-2.5 text-center text-[13px] leading-relaxed text-body">
            No account needed to start.
          </p>
          <p className="mt-1 text-center text-[12px] leading-relaxed text-muted">
            You'll need a bank-card-sized card to calibrate, a dimly lit room, a screen at
            arm's length, and to cover one eye when prompted.
          </p>
          {!studyReady && (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
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
              className="flex-1 py-3 min-h-[48px] bg-surface hover:bg-subtle rounded-xl font-medium text-body transition-all border border-line hover:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base"
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M12 8v4l3 3" />
                <circle cx="12" cy="12" r="10" />
              </svg>
              Results
              {resultCount > 0 && (
                <span className="tnum ml-1.5 text-muted text-sm">({resultCount})</span>
              )}
            </button>
          </div>
        ) : (
          <div className="fade-up fade-up-6 space-y-2">
            <button
              onClick={() => { setAuthMode('register'); setShowAuth(true) }}
              className="w-full py-3 min-h-[48px] bg-surface hover:bg-subtle rounded-xl text-sm font-medium text-body hover:text-ink transition-all border border-line hover:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-base"
            >
              <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              Create account
            </button>
            <p className="text-center text-sm text-body">
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
            <span className="text-muted">
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
              className="text-muted hover:text-ink transition-colors min-h-[44px] px-2"
            >
              Sign out
            </button>
            <button
              onClick={() => { setShowDeleteAccount(true); setDeleteAccountTyped(''); setDeleteAccountError(null) }}
              className="text-red-600 dark:text-red-400 hover:text-red-700 transition-colors min-h-[44px] px-2"
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
        <nav aria-label="Site navigation" className="fade-up fade-up-8 pt-2 border-t border-line">
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
            <button onClick={() => { setPage('demo'); setDemoScenarioId(null); setDemoMode('goldmann') }} className="text-muted hover:text-ink text-xs transition-colors min-h-[44px] px-1">Demos</button>
            <button onClick={() => setPage('methods')} className="text-muted hover:text-ink text-xs transition-colors min-h-[44px] px-1">Methods</button>
            <button onClick={() => setPage('science')} className="text-muted hover:text-ink text-xs transition-colors min-h-[44px] px-1">References</button>
            <button onClick={() => setPage('clinicians')} className="text-muted hover:text-ink text-xs transition-colors min-h-[44px] px-1">Clinicians</button>
            <button onClick={() => setPage('contact')} className="text-muted hover:text-ink text-xs transition-colors min-h-[44px] px-1">Contact</button>
            <button onClick={() => setPage('privacy')} className="text-muted hover:text-ink text-xs transition-colors min-h-[44px] px-1">Privacy</button>
          </div>
          <div className="flex justify-center gap-3 pt-2">
            <a
              href={whatsappShareUrl()}
              onClick={() => {
                trackEvent('whatsapp_shared', getDeviceId(), { source: 'home_footer' }).catch(() => {})
              }}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1.5 text-muted hover:text-green-600 text-xs transition-colors min-h-[44px] px-1"
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
                className="inline-flex items-center gap-1.5 text-muted hover:text-ink text-xs transition-colors min-h-[44px] px-1"
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

      {authModal}

      {showDeleteAccount && user && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-title"
          onClick={closeDeleteAccountModal}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-red-200 dark:border-red-800 bg-surface p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 id="delete-account-title" className="text-lg font-semibold text-ink">Delete your account</h2>
            <p className="mt-3 text-sm text-body">
              This will permanently delete your account ({user.email}) and all your test results, surveys, saved screens, and active sessions. This cannot be undone.
            </p>
            <p className="mt-4 text-xs text-muted">
              Type your name (<span className="font-mono text-ink">{user.displayName}</span>) to confirm:
            </p>
            <input
              type="text"
              autoFocus
              value={deleteAccountTyped}
              onChange={e => setDeleteAccountTyped(e.target.value)}
              className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
              placeholder={user.displayName}
              disabled={deleteAccountBusy}
            />
            {deleteAccountError && (
              <p className="mt-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-200">
                {deleteAccountError}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-lg border border-line bg-surface px-4 py-2 text-sm text-body hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                disabled={deleteAccountBusy}
                onClick={closeDeleteAccountModal}
              >
                Cancel
              </button>
              <button
                className="rounded-lg border border-red-600 bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
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
