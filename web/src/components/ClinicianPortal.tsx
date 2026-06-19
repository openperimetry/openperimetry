import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_ADVANCED_SETTINGS,
  useAdvancedSettings,
  useSetAdvancedSettings,
  type AdvancedSettings,
} from '../advancedSettings'
import { STATIC_GRID_INFO } from '../grids'
import type { RunSpeedMode, TestType } from '../types'
import {
  deleteUserStudyProfile,
  listUserStudyProfiles,
  makeUserProfileId,
  upsertUserStudyProfile,
} from '../userStudyProfiles'
import {
  deleteClinicalParticipant,
  deleteClinicScreen as apiDeleteClinicScreen,
  listClinicalParticipants,
  listClinicScreens as apiListClinicScreens,
  setActiveClinicScreen as apiSetActiveClinicScreen,
  upsertClinicalParticipant,
  upsertClinicScreen as apiUpsertClinicScreen,
  getClinicianVFResults,
  getClinicianVFResultDetail,
  type AdminVFResultRecord,
} from '../api'
import { exportToOvfx } from '../ovfx'
import { useAuth } from '../AuthContext'
import {
  makeSessionId,
  type ClinicalParticipant,
} from '../clinicalParticipants'
import {
  addScreen,
  deleteScreen,
  getActiveScreenId,
  listScreens,
  replaceAllScreens,
  setActiveScreen,
  updateScreen,
  type NewScreenInput,
  type SavedScreen,
} from '../screenCalibration'
import { STANDARD_PROFILES } from '../standardProfiles'
import {
  DEFAULT_STUDY_MODE_STATE,
  exportStudyProfileAsFile,
  isStudyReady,
  parseStudyProfileFile,
  type StudyModeState,
  type StudyProfile,
  useSetStudyMode,
  useStudyMode,
} from '../studyMode'
import { getResults } from '../storage'
import type { Eye, TestResult } from '../types'
import { BackButton } from './AccessibleNav'

interface Props {
  onBack: () => void
  onStartTest: (eye: Eye) => void
}

const CREDIT_CARD_WIDTH_MM = 85.6
const CREDIT_CARD_HEIGHT_MM = 53.98

type WizardStep = 'card' | 'distance' | 'brightness' | 'name'
type WizardDraft = NewScreenInput & { editingId?: string }

interface ParticipantDraft {
  id: string
  label: string
}

const EMPTY_DRAFT: ParticipantDraft = {
  id: '',
  label: '',
}

function updateSession(state: StudyModeState, patch: Partial<StudyModeState['session']>): StudyModeState {
  return {
    ...state,
    session: {
      ...state.session,
      ...patch,
    },
  }
}

function resultParticipantId(result: TestResult): string {
  return result.study?.participantId ?? ''
}

function resultSummary(result: TestResult): string {
  const date = new Date(result.date)
  const eye = result.eye === 'right' ? 'OD' : 'OS'
  const kind = result.testType === 'static' ? 'Static' : 'Goldmann'
  const protocol = result.protocol?.label ? ` · ${result.protocol.label}` : ''
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${eye} · ${kind}${protocol}`
}

function applyProfileToState(profile: StudyProfile, state: StudyModeState): StudyModeState {
  // Only stage the profile + bring the rest of the state along. The
  // `enabled` flag is intentionally left untouched here — selecting a
  // profile in the portal must not retroactively turn the user's home
  // screen into a locked study-mode picker. App.tsx flips `enabled`
  // only when the run actually starts from the portal, and flips it
  // back when the run ends.
  return {
    ...state,
    profile,
  }
}

export function ClinicianPortal({ onBack, onStartTest }: Props) {
  const studyMode = useStudyMode()
  const setStudyMode = useSetStudyMode()
  const setAdvancedSettings = useSetAdvancedSettings()
  const { user } = useAuth()
  const [participants, setParticipants] = useState<ClinicalParticipant[]>([])
  const [draft, setDraft] = useState<ParticipantDraft>(EMPTY_DRAFT)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [eye, setEye] = useState<Eye>('right')
  const [screens, setScreens] = useState<SavedScreen[]>(() => listScreens())
  const [activeScreenId, setActiveScreenIdState] = useState<string | null>(() => getActiveScreenId())
  const [userProfiles, setUserProfiles] = useState<StudyProfile[]>(() => listUserStudyProfiles())
  const advanced = useAdvancedSettings()
  // Create-protocol form. Null when closed, otherwise the draft. We
  // baseline `advancedSettings` from the live panel state so a clinician
  // who tweaks the panel before clicking "Create" sees those tweaks
  // baked into the new profile (and can revert if they don't want them).
  type ProfileDraft = {
    label: string
    studyId: string
    testType: TestType
    speedMode: RunSpeedMode
    extendedField: boolean
    staticGridPattern: StudyProfile['staticGridPattern']
    notes: string
    advancedMode: 'defaults' | 'current' | 'manual'
    manualAdvanced: AdvancedSettings
  }
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null)
  type Tab = 'participants' | 'protocols' | 'workstations' | 'results'
  const [tab, setTab] = useState<Tab>('participants')
  // Add-Workstation wizard state. Null when not editing; otherwise the
  // step + draft. Drafts are committed only when the wizard reaches
  // "name" and the user confirms, so dismissing mid-flow doesn't leave
  // a half-calibrated entry behind.
  const [wizard, setWizard] = useState<{ step: WizardStep; draft: WizardDraft } | null>(null)
  const profileInputRef = useRef<HTMLInputElement | null>(null)
  const results = useMemo(() => getResults().sort((a, b) => b.date.localeCompare(a.date)), [])

  // Cross-study results — populated from /api/clinician/vf-results,
  // which returns every study-tagged result across all users. Used by
  // the Results tab's study/protocol/participant/session filters and
  // OVFX export. The per-participant view above this still relies on
  // local `results` for "what did THIS clinician just run".
  const [studyResults, setStudyResults] = useState<AdminVFResultRecord[]>([])
  const [studyResultsError, setStudyResultsError] = useState<string | null>(null)
  const [studyIdFilter, setStudyIdFilter] = useState('all')
  const [protocolIdFilter, setProtocolIdFilter] = useState('all')
  const [participantFilter, setParticipantFilter] = useState('')
  const [sessionFilter, setSessionFilter] = useState('')
  const [exportingBundle, setExportingBundle] = useState(false)
  const [studyResultsNotice, setStudyResultsNotice] = useState<{ tone: 'neutral' | 'success' | 'error'; message: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    getClinicianVFResults()
      .then(res => { if (!cancelled) setStudyResults(res.results) })
      .catch(err => { if (!cancelled) setStudyResultsError((err as Error).message || 'Could not load study results.') })
    return () => { cancelled = true }
  }, [])
  const studyIdOptions = useMemo(
    () => [...new Set(studyResults.map(r => r.studyId).filter((v): v is string => Boolean(v)))].sort(),
    [studyResults],
  )
  const protocolIdOptions = useMemo(
    () => [...new Set(studyResults.map(r => r.protocolId).filter((v): v is string => Boolean(v)))].sort(),
    [studyResults],
  )
  const filteredStudyResults = useMemo(() => {
    const participantNeedle = participantFilter.trim().toLowerCase()
    const sessionNeedle = sessionFilter.trim().toLowerCase()
    return studyResults.filter(r => {
      if (studyIdFilter !== 'all' && r.studyId !== studyIdFilter) return false
      if (protocolIdFilter !== 'all' && r.protocolId !== protocolIdFilter) return false
      if (participantNeedle && !(r.participantId ?? '').toLowerCase().includes(participantNeedle)) return false
      if (sessionNeedle && !(r.sessionId ?? '').toLowerCase().includes(sessionNeedle)) return false
      return true
    })
  }, [studyResults, studyIdFilter, protocolIdFilter, participantFilter, sessionFilter])
  const clearStudyFilters = () => {
    setStudyIdFilter('all')
    setProtocolIdFilter('all')
    setParticipantFilter('')
    setSessionFilter('')
    setStudyResultsNotice(null)
  }
  const exportFilteredOvfxBundle = async () => {
    if (filteredStudyResults.length === 0 || exportingBundle) return
    setExportingBundle(true)
    setStudyResultsNotice({ tone: 'neutral', message: `Preparing OVFX bundle for ${filteredStudyResults.length} result(s)…` })
    try {
      const docs = await Promise.all(filteredStudyResults.map(async row => {
        const { result } = await getClinicianVFResultDetail(row.userId, row.id)
        return exportToOvfx(JSON.parse(result.data) as TestResult)
      }))
      const bundle = {
        bundleVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        count: docs.length,
        filters: {
          studyId: studyIdFilter !== 'all' ? studyIdFilter : null,
          protocolId: protocolIdFilter !== 'all' ? protocolIdFilter : null,
          participantQuery: participantFilter.trim() || null,
          sessionQuery: sessionFilter.trim() || null,
        },
        results: docs,
      }
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `vfc-study-ovfx-bundle_${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      setStudyResultsNotice({ tone: 'success', message: `OVFX bundle exported for ${docs.length} result(s).` })
    } catch (err) {
      setStudyResultsNotice({ tone: 'error', message: (err as Error).message ?? 'Failed to export OVFX bundle.' })
    } finally {
      setExportingBundle(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    listClinicalParticipants()
      .then(res => {
        if (!cancelled) setParticipants(res.participants)
      })
      .catch(err => {
        if (!cancelled) setError((err as Error).message || 'Could not load participants.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // Seed local workstation registry from the clinician's account so a
  // device the clinician hasn't used before still sees their named
  // workstations. Local state stays canonical for read paths (so
  // CalibrationScreen doesn't pay a network round-trip), and write
  // paths mirror to the API below.
  useEffect(() => {
    let cancelled = false
    apiListClinicScreens()
      .then(res => {
        if (cancelled) return
        const remoteScreens: SavedScreen[] = res.screens.map(s => ({
          id: s.id,
          label: s.label,
          cardWidthPx: s.cardWidthPx,
          screenWidthPx: s.screenWidthPx,
          screenHeightPx: s.screenHeightPx,
          devicePixelRatio: s.devicePixelRatio,
          viewingDistanceCm: s.viewingDistanceCm ?? undefined,
          brightnessFloor: s.brightnessFloor ?? undefined,
          savedAt: s.savedAt,
        }))
        const remoteActive = res.screens.find(s => s.isActive)?.id ?? null
        replaceAllScreens({ screens: remoteScreens, activeId: remoteActive })
        setScreens(listScreens())
        setActiveScreenIdState(getActiveScreenId())
      })
      .catch(() => { /* offline or first-time clinician — local stays canonical */ })
    return () => { cancelled = true }
  }, [])

  const participantById = useMemo(
    () => new Map(participants.map(p => [p.id, p])),
    [participants],
  )
  const countsByParticipant = useMemo(() => {
    const counts = new Map<string, number>()
    for (const result of results) {
      const id = resultParticipantId(result)
      if (!id) continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }, [results])
  const activeParticipant = participantById.get(studyMode.session.participantId)
  const activeScreen = screens.find(s => s.id === activeScreenId) ?? null
  const search = query.trim().toLowerCase()
  const filteredParticipants = participants.filter(p => {
    if (!search) return true
    return [p.id, p.label].some(value => value.toLowerCase().includes(search))
  })
  // Only match real participant runs — personal (non-study) results
  // have an empty participantId, which would otherwise collide with
  // an empty session.participantId when no participant is picked yet
  // and inflate the Results badge with the clinician's own runs.
  const selectedResults = studyMode.session.participantId
    ? results.filter(result => resultParticipantId(result) === studyMode.session.participantId)
    : []

  const selectParticipant = (participant: ClinicalParticipant) => {
    setStudyMode(updateSession(studyMode, {
      participantId: participant.id,
      sessionId: studyMode.session.sessionId || makeSessionId(participant.id),
    }))
    setNotice(`${participant.label} selected for the next test.`)
  }

  const handleAddParticipant = async () => {
    const id = draft.id.trim()
    const label = draft.label.trim()
    if (!id || !label) {
      setNotice('Participant ID and display name are required.')
      return
    }
    if (participants.some(p => p.id === id)) {
      setNotice('A participant with that ID already exists.')
      return
    }
    const now = new Date().toISOString()
    const participant: ClinicalParticipant = {
      id,
      label,
      createdAt: now,
      updatedAt: now,
    }
    try {
      const saved = await upsertClinicalParticipant(participant)
      setParticipants(prev => [...prev, saved.participant].sort((a, b) => a.id.localeCompare(b.id)))
      setDraft(EMPTY_DRAFT)
      selectParticipant(saved.participant)
    } catch (err) {
      setNotice((err as Error).message || 'Could not save participant.')
    }
  }

  const handleDeleteParticipant = async (participant: ClinicalParticipant) => {
    try {
      await deleteClinicalParticipant(participant.id)
      setParticipants(prev => prev.filter(p => p.id !== participant.id))
      if (studyMode.session.participantId === participant.id) {
        setStudyMode(updateSession(studyMode, { participantId: '', sessionId: '' }))
      }
      setNotice(`${participant.label} removed from the participant list.`)
    } catch (err) {
      setNotice((err as Error).message || 'Could not remove participant.')
    }
  }

  const handleProfileSelect = (profile: StudyProfile) => {
    setAdvancedSettings(profile.advancedSettings)
    setStudyMode(applyProfileToState(profile, studyMode))
    setNotice(`${profile.label} selected as the active protocol.`)
  }

  const beginCreateProfile = () => {
    setProfileDraft({
      label: '',
      studyId: 'custom',
      testType: 'goldmann',
      speedMode: 'normal',
      extendedField: false,
      staticGridPattern: advanced.staticGridPattern,
      notes: '',
      advancedMode: 'defaults',
      // Seed the manual editor from the user's current advanced settings
      // so opening "Configure manually" starts from a sensible baseline
      // (their last live tweaks) rather than always from raw defaults.
      manualAdvanced: { ...advanced },
    })
  }

  const cancelCreateProfile = () => setProfileDraft(null)

  const submitCreateProfile = () => {
    if (!profileDraft) return
    const label = profileDraft.label.trim()
    if (!label) {
      setNotice('Protocol label is required.')
      return
    }
    const studyId = profileDraft.studyId.trim() || 'custom'
    const baselineAdvanced =
      profileDraft.advancedMode === 'current' ? advanced
      : profileDraft.advancedMode === 'manual' ? profileDraft.manualAdvanced
      : DEFAULT_ADVANCED_SETTINGS
    // Bake the static grid choice into advancedSettings so the profile
    // is self-contained — the rest of the codebase reads the grid from
    // advanced.staticGridPattern, not from profile.staticGridPattern.
    const advancedSettings = profileDraft.testType === 'static'
      ? { ...baselineAdvanced, staticGridPattern: profileDraft.staticGridPattern }
      : baselineAdvanced
    const profile: StudyProfile = {
      id: makeUserProfileId(label),
      label,
      studyId,
      version: '1.0.0',
      testType: profileDraft.testType,
      speedMode: profileDraft.speedMode,
      extendedField: profileDraft.testType === 'goldmann' ? profileDraft.extendedField : false,
      staticGridPattern: profileDraft.testType === 'static' ? profileDraft.staticGridPattern : '24-2',
      advancedSettings,
      notes: profileDraft.notes.trim() || undefined,
    }
    upsertUserStudyProfile(profile)
    setUserProfiles(listUserStudyProfiles())
    setProfileDraft(null)
    handleProfileSelect(profile)
    setNotice(`${profile.label} created and selected as the active protocol.`)
  }

  const handleDeleteUserProfile = (profile: StudyProfile) => {
    deleteUserStudyProfile(profile.id)
    setUserProfiles(listUserStudyProfiles())
    if (studyMode.profile?.id === profile.id) {
      setStudyMode({ ...studyMode, profile: null, enabled: false })
    }
    setNotice(`${profile.label} removed.`)
  }

  const refreshScreens = () => {
    setScreens(listScreens())
    setActiveScreenIdState(getActiveScreenId())
  }

  const beginAddScreen = () => {
    setWizard({
      step: 'card',
      draft: { label: '', cardWidthPx: 320 },
    })
  }

  const beginEditScreen = (screen: SavedScreen) => {
    setWizard({
      step: 'card',
      draft: {
        editingId: screen.id,
        label: screen.label,
        cardWidthPx: screen.cardWidthPx,
        viewingDistanceCm: screen.viewingDistanceCm,
        brightnessFloor: screen.brightnessFloor,
      },
    })
  }

  const cancelWizard = () => setWizard(null)

  const advanceWizard = (next: WizardStep, patch?: Partial<WizardDraft>) => {
    setWizard(prev => prev && {
      step: next,
      draft: patch ? { ...prev.draft, ...patch } : prev.draft,
    })
  }

  const mirrorScreenToApi = (screen: SavedScreen) => {
    apiUpsertClinicScreen({
      id: screen.id,
      label: screen.label,
      cardWidthPx: screen.cardWidthPx,
      screenWidthPx: screen.screenWidthPx,
      screenHeightPx: screen.screenHeightPx,
      devicePixelRatio: screen.devicePixelRatio,
      viewingDistanceCm: screen.viewingDistanceCm ?? null,
      brightnessFloor: screen.brightnessFloor ?? null,
      savedAt: screen.savedAt,
    }).catch(() => { /* local stays canonical; surface only if user retries */ })
  }

  const finishWizard = (finalDraft: WizardDraft) => {
    const input: NewScreenInput = {
      label: finalDraft.label.trim() || 'Workstation',
      cardWidthPx: finalDraft.cardWidthPx,
      viewingDistanceCm: finalDraft.viewingDistanceCm,
      brightnessFloor: finalDraft.brightnessFloor,
    }
    let saved: SavedScreen | null
    if (finalDraft.editingId) {
      saved = updateScreen(finalDraft.editingId, input)
      setNotice(`${input.label} updated.`)
    } else {
      saved = addScreen(input)
      setNotice(`${saved.label} saved and set as the active workstation.`)
    }
    setWizard(null)
    refreshScreens()
    if (saved) {
      mirrorScreenToApi(saved)
      // Newly-added workstations become the active one locally; mirror
      // that activation server-side too.
      if (!finalDraft.editingId) apiSetActiveClinicScreen(saved.id).catch(() => {})
    }
  }

  const handleActivateScreen = (screen: SavedScreen) => {
    setActiveScreen(screen.id)
    refreshScreens()
    setNotice(`${screen.label} is now the active workstation.`)
    apiSetActiveClinicScreen(screen.id).catch(() => {})
  }

  const handleDeleteScreen = (screen: SavedScreen) => {
    deleteScreen(screen.id)
    refreshScreens()
    setNotice(`${screen.label} removed.`)
    apiDeleteClinicScreen(screen.id).catch(() => {})
  }

  const studyReady = isStudyReady(studyMode)
  const canStartTest = studyReady && !!studyMode.profile

  const handleStartTest = () => {
    if (!canStartTest) return
    onStartTest(eye)
  }

  const handleProfileImport = async (file: File | null) => {
    if (!file) return
    try {
      const profile = await parseStudyProfileFile(file)
      handleProfileSelect(profile)
      setNotice(`${profile.label} imported and selected as the active protocol.`)
    } catch (err) {
      setNotice((err as Error).message || 'Could not import protocol.')
    } finally {
      if (profileInputRef.current) profileInputRef.current.value = ''
    }
  }

  const missing: string[] = []
  if (!activeParticipant) missing.push('participant')
  if (!studyMode.profile) missing.push('protocol')
  if (!studyMode.session.sessionId.trim()) missing.push('session ID')

  const tabs: { id: Tab; label: string; badge?: string }[] = [
    { id: 'participants', label: 'Participants', badge: String(participants.length) },
    { id: 'protocols', label: 'Protocols' },
    { id: 'workstations', label: 'Workstations', badge: String(screens.length) },
    { id: 'results', label: 'Results', badge: String(studyResults.length) },
  ]

  return (
    <div className="min-h-[100dvh] bg-base text-body safe-pad p-6 animate-page-in">
      <main className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">Clinician portal</p>
            <h1 className="mt-1 text-3xl font-heading font-bold">Study sessions</h1>
          </div>
          <BackButton onClick={onBack} label="Home" />
        </header>

        {notice && (
          <div className="rounded-xl border border-teal/25 bg-teal/10 px-4 py-3 text-sm text-teal" role="status">
            {notice}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300" role="alert">
            {error}
          </div>
        )}

        {/* Session summary — the single source of truth for what's
            about to run. Rows show the three required choices
            (participant, protocol, workstation) plus the eye selector,
            and quick-link to the management tab when something's
            missing. Session metadata (session ID + visit/repeat/
            operator) sits below the choices so the clinician can fill
            them in without leaving the summary. */}
        <section className="rounded-2xl border border-line bg-surface p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted">Next session</p>
              <p className="mt-1 text-sm text-muted">
                {missing.length === 0
                  ? 'Ready — confirm session ID below and start.'
                  : `Pick ${missing.join(', ')} to enable Start.`}
              </p>
            </div>
            {studyMode.profile || studyMode.session.participantId ? (
              <button
                onClick={() => setStudyMode(DEFAULT_STUDY_MODE_STATE)}
                className="text-xs text-muted underline decoration-dotted hover:text-body"
              >
                clear session
              </button>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryRow
              label="Participant"
              value={activeParticipant ? `${activeParticipant.label} · ${activeParticipant.id}` : null}
              action={activeParticipant ? 'Change' : 'Pick'}
              onAction={() => setTab('participants')}
            />
            <SummaryRow
              label="Protocol"
              value={studyMode.profile ? studyMode.profile.label : null}
              action={studyMode.profile ? 'Change' : 'Pick'}
              onAction={() => setTab('protocols')}
            />
            <SummaryRow
              label="Workstation"
              value={activeScreen ? activeScreen.label : null}
              valueHint={activeScreen
                ? [
                    `card ${activeScreen.cardWidthPx.toFixed(0)} px`,
                    activeScreen.viewingDistanceCm != null ? `${activeScreen.viewingDistanceCm} cm` : null,
                    activeScreen.brightnessFloor != null ? `${(activeScreen.brightnessFloor * 100).toFixed(1)}%` : null,
                  ].filter(Boolean).join(' · ')
                : 'optional — calibration will run if none'}
              action={activeScreen ? 'Change' : 'Add'}
              onAction={() => setTab('workstations')}
              optional
            />
          </div>

          <div className="grid gap-3 rounded-xl border border-line bg-subtle p-3 sm:grid-cols-[auto_1fr]">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium uppercase tracking-[0.08em] text-muted">Eye</span>
              <div className="flex gap-1" role="radiogroup" aria-label="Eye for next test">
                {(['left', 'both', 'right'] as const).map(value => {
                  const label = value === 'right' ? 'OD' : value === 'left' ? 'OS' : 'OU'
                  const selected = eye === value
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setEye(value)}
                      className={`min-w-[44px] rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                        selected
                          ? 'border-accent bg-accent-tint text-accent'
                          : 'border-line bg-subtle text-body hover:bg-subtle-2'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_0.6fr_1fr]">
              <input
                value={studyMode.session.sessionId}
                onChange={e => setStudyMode(updateSession(studyMode, { sessionId: e.target.value }))}
                className="input-field"
                placeholder="Session ID (required)"
                aria-label="Session ID"
              />
              <input
                value={studyMode.session.visitId}
                onChange={e => setStudyMode(updateSession(studyMode, { visitId: e.target.value }))}
                className="input-field"
                placeholder="Visit (optional)"
                aria-label="Visit ID"
              />
              <input
                type="number"
                min={1}
                step={1}
                value={studyMode.session.repeatIndex}
                onChange={e => {
                  const next = Number(e.target.value)
                  setStudyMode(updateSession(studyMode, {
                    repeatIndex: Number.isInteger(next) && next >= 1 ? next : 1,
                  }))
                }}
                className="input-field"
                placeholder="Repeat"
                aria-label="Repeat number"
              />
              <input
                value={studyMode.session.operatorId}
                onChange={e => setStudyMode(updateSession(studyMode, { operatorId: e.target.value }))}
                className="input-field"
                placeholder="Operator (optional)"
                aria-label="Operator ID"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleStartTest}
            disabled={!canStartTest}
            className={`w-full rounded-xl px-4 py-3.5 text-base font-semibold transition-colors ${
              canStartTest
                ? 'bg-accent text-white hover:bg-accent-light shadow-[0_4px_24px_rgba(10,108,201,0.22)]'
                : 'cursor-not-allowed bg-subtle-2 text-muted'
            }`}
          >
            Start test session
            {canStartTest && (
              <span className="ml-2 text-xs font-medium text-white/85">
                · {eye === 'right' ? 'OD' : eye === 'left' ? 'OS' : 'OU'}
                {studyMode.profile && ` · ${studyMode.profile.testType === 'static' ? 'Static' : 'Goldmann'}`}
              </span>
            )}
          </button>
        </section>

        {/* Management tabs — surface only the management UI for the
            section the clinician is editing, instead of stacking every
            list at once. Defaults to Participants since that's the most
            common entry point. */}
        <nav className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Manage">
          {tabs.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-3 py-2.5 text-sm font-medium transition-colors ${
                tab === t.id ? 'text-accent' : 'text-muted hover:text-body'
              }`}
            >
              {t.label}
              {t.badge && (
                <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-mono ${
                  tab === t.id ? 'bg-accent/15 text-accent' : 'bg-subtle-2 text-muted'
                }`}>{t.badge}</span>
              )}
              <span className={`absolute -bottom-[1px] inset-x-2 h-[2px] rounded-full bg-accent transition-all duration-200 ${
                tab === t.id ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0'
              }`} />
            </button>
          ))}
        </nav>

        <section className="space-y-4">
          {tab === 'participants' && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
              <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-base font-heading font-semibold">Participants</h2>
                  <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    className="input-field max-w-xs"
                    placeholder="Search"
                    aria-label="Search participants"
                  />
                </div>
                <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {loading && (
                    <div className="px-3 py-8 text-center text-sm text-muted">Loading…</div>
                  )}
                  {filteredParticipants.map(participant => {
                    const selected = participant.id === studyMode.session.participantId
                    const count = countsByParticipant.get(participant.id) ?? 0
                    return (
                      <div key={participant.id} className={`grid gap-3 px-3 py-3 sm:grid-cols-[1fr_auto] ${selected ? 'bg-teal/10' : 'bg-subtle'}`}>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-medium text-ink">{participant.label}</span>
                            <span className="font-mono text-xs text-muted">{participant.id}</span>
                            {selected && <span className="rounded-full border border-teal/25 bg-teal/10 px-2 py-0.5 text-[11px] text-teal">Selected</span>}
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            {count} result{count === 1 ? '' : 's'} · Updated {new Date(participant.updatedAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          <button
                            onClick={() => selectParticipant(participant)}
                            className="rounded-lg border border-line bg-subtle px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-subtle-2"
                          >
                            Select
                          </button>
                          <button
                            onClick={() => handleDeleteParticipant(participant)}
                            className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/15"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  {!loading && filteredParticipants.length === 0 && (
                    <div className="px-3 py-8 text-center text-sm text-muted">No matches.</div>
                  )}
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
                <h2 className="text-base font-heading font-semibold">Add participant</h2>
                <p className="text-xs leading-5 text-muted">
                  Use a pseudonymous code. Records save to your account{user?.email ? ` (${user.email})` : ''}; keep clinical details in your source system.
                </p>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Participant ID</span>
                  <input value={draft.id} onChange={e => setDraft({ ...draft, id: e.target.value })} className="input-field" placeholder="P-002" />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Display name</span>
                  <input value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} className="input-field" placeholder="Participant 002" />
                </label>
                <button onClick={handleAddParticipant} className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-light">
                  Add and select
                </button>
              </div>
            </div>
          )}

          {tab === 'protocols' && (
            <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-heading font-semibold">Protocols</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={profileInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="sr-only"
                    onChange={e => { void handleProfileImport(e.target.files?.[0] ?? null) }}
                  />
                  {!profileDraft && (
                    <button
                      onClick={beginCreateProfile}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-light"
                    >
                      Create protocol
                    </button>
                  )}
                  <button
                    onClick={() => profileInputRef.current?.click()}
                    className="rounded-lg border border-line bg-subtle px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-subtle-2"
                  >
                    Import
                  </button>
                  {studyMode.profile && (
                    <button
                      onClick={() => {
                        if (studyMode.profile) exportStudyProfileAsFile(studyMode.profile)
                      }}
                      className="rounded-lg border border-line bg-subtle px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-subtle-2"
                    >
                      Export active
                    </button>
                  )}
                </div>
              </div>

              {profileDraft && (
                <ProtocolForm
                  draft={profileDraft}
                  onChange={setProfileDraft}
                  onCancel={cancelCreateProfile}
                  onSubmit={submitCreateProfile}
                />
              )}

              {userProfiles.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Your protocols</p>
                  <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {userProfiles.map(profile => {
                      const isActive = studyMode.profile?.id === profile.id
                      return (
                        <div
                          key={profile.id}
                          className={`grid gap-2 px-3 py-2.5 sm:grid-cols-[1fr_auto] ${isActive ? 'bg-teal/10' : 'bg-subtle'}`}
                        >
                          <button
                            onClick={() => handleProfileSelect(profile)}
                            className="min-w-0 text-left"
                          >
                            <span className="block text-sm font-medium leading-5 text-ink">
                              {profile.label}
                              <span className="ml-2 rounded-full border border-line bg-subtle px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wider text-muted">
                                {profile.testType === 'static' ? 'Static' : 'Goldmann'}
                              </span>
                            </span>
                            {profile.notes && (
                              <span className="mt-0.5 block text-xs leading-5 text-muted">{profile.notes}</span>
                            )}
                          </button>
                          <div className="flex items-center gap-2 sm:justify-end">
                            <button
                              onClick={() => exportStudyProfileAsFile(profile)}
                              className="rounded-lg border border-line bg-subtle px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:bg-subtle-2"
                            >
                              Export
                            </button>
                            <button
                              onClick={() => handleDeleteUserProfile(profile)}
                              className="rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/15"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Built-in protocols</p>
                <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {STANDARD_PROFILES.map(profile => (
                    <button
                      key={profile.id}
                      onClick={() => handleProfileSelect(profile)}
                      className={`block w-full px-3 py-2.5 text-left transition-colors hover:bg-subtle-2 ${
                        studyMode.profile?.id === profile.id ? 'bg-teal/10' : 'bg-subtle'
                      }`}
                    >
                      <span className="block text-sm font-medium leading-5 text-ink">{profile.label}</span>
                      {profile.notes && <span className="mt-0.5 block text-xs leading-5 text-muted">{profile.notes}</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'workstations' && (
            <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-heading font-semibold">Workstations</h2>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Each entry captures the bank-card width and (optionally) chin-rest distance and brightness floor. The active workstation's saved values let tests skip those calibration steps.
                  </p>
                </div>
                {!wizard && (
                  <button
                    type="button"
                    onClick={beginAddScreen}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-light"
                  >
                    Add workstation
                  </button>
                )}
              </div>

              {screens.length === 0 && !wizard && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                  No workstations saved yet. The first test on this device will run the full calibration.
                </div>
              )}

              {screens.length > 0 && !wizard && (
                <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {screens.map(screen => {
                    const isActive = screen.id === activeScreenId
                    const has = (val: number | undefined) => val != null
                    return (
                      <div
                        key={screen.id}
                        className={`grid gap-3 px-3 py-3 sm:grid-cols-[1fr_auto] ${isActive ? 'bg-teal/10' : 'bg-subtle'}`}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-medium text-ink">{screen.label}</span>
                            {isActive && (
                              <span className="rounded-full border border-teal/25 bg-teal/10 px-2 py-0.5 text-[11px] text-teal">Active</span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            {screen.screenWidthPx}×{screen.screenHeightPx} px · card {screen.cardWidthPx.toFixed(0)} px
                            {has(screen.viewingDistanceCm) && ` · ${screen.viewingDistanceCm} cm`}
                            {has(screen.brightnessFloor) && ` · brightness ${(screen.brightnessFloor! * 100).toFixed(1)}%`}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          {!isActive && (
                            <button
                              type="button"
                              onClick={() => handleActivateScreen(screen)}
                              className="rounded-lg border border-line bg-subtle px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-subtle-2"
                            >
                              Make active
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => beginEditScreen(screen)}
                            className="rounded-lg border border-line bg-subtle px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-subtle-2"
                          >
                            Recalibrate
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteScreen(screen)}
                            className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/15"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {wizard && (
                <ScreenSetupWizard
                  step={wizard.step}
                  draft={wizard.draft}
                  onCancel={cancelWizard}
                  onAdvance={advanceWizard}
                  onFinish={finishWizard}
                />
              )}
            </div>
          )}

          {tab === 'results' && (
            <div className="space-y-4">
              {/* Active-participant quick view — only shows local runs
                  for the currently-selected participant. The cross-
                  study list below covers every clinician's runs. */}
              {activeParticipant && (
                <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-base font-heading font-semibold">Latest for {activeParticipant.label}</h2>
                    <span className="text-xs text-muted">{selectedResults.length} local result{selectedResults.length === 1 ? '' : 's'}</span>
                  </div>
                  {selectedResults.length === 0 ? (
                    <div className="rounded-xl border border-line bg-subtle px-4 py-6 text-center text-sm text-muted">
                      No local runs tied to this participant yet — full study history is in the table below.
                    </div>
                  ) : (
                    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                      {selectedResults.map(result => (
                        <div key={result.id} className="px-3 py-3">
                          <div className="text-sm font-medium text-ink">{resultSummary(result)}</div>
                          <div className="mt-1 font-mono text-xs text-muted">
                            {result.study?.sessionId ?? 'no-session'} · {result.id}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Cross-study results — server-fetched, every study-
                  tagged run by any user. */}
              <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h2 className="text-base font-heading font-semibold">Study results</h2>
                    <p className="text-xs text-muted mt-1">
                      {filteredStudyResults.length} of {studyResults.length} study-tagged result{studyResults.length === 1 ? '' : 's'} match.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-primary rounded-lg px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => void exportFilteredOvfxBundle()}
                    disabled={filteredStudyResults.length === 0 || exportingBundle}
                  >
                    {exportingBundle ? 'Exporting OVFX bundle…' : 'Export OVFX bundle'}
                  </button>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.08em] text-muted">Study</span>
                    <select
                      className="input-field"
                      value={studyIdFilter}
                      onChange={e => setStudyIdFilter(e.target.value)}
                    >
                      <option value="all">All studies</option>
                      {studyIdOptions.map(id => <option key={id} value={id}>{id}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.08em] text-muted">Protocol</span>
                    <select
                      className="input-field"
                      value={protocolIdFilter}
                      onChange={e => setProtocolIdFilter(e.target.value)}
                    >
                      <option value="all">All protocols</option>
                      {protocolIdOptions.map(id => <option key={id} value={id}>{id}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.08em] text-muted">Participant contains</span>
                    <input
                      className="input-field"
                      value={participantFilter}
                      onChange={e => setParticipantFilter(e.target.value)}
                      placeholder="participant-001"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.08em] text-muted">Session contains</span>
                    <input
                      className="input-field"
                      value={sessionFilter}
                      onChange={e => setSessionFilter(e.target.value)}
                      placeholder="session-a"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted">
                    OVFX export preserves study metadata for every result in the current filter.
                  </p>
                  <button
                    type="button"
                    className="text-xs text-muted hover:text-ink"
                    onClick={clearStudyFilters}
                  >
                    Clear filters
                  </button>
                </div>

                {studyResultsError && (
                  <div className="rounded-lg border border-red-800/40 bg-red-900/20 px-3 py-2 text-sm text-red-300">
                    {studyResultsError}
                  </div>
                )}
                {studyResultsNotice && (
                  <div
                    className={`rounded-lg border px-3 py-2 text-sm ${
                      studyResultsNotice.tone === 'error'
                        ? 'border-red-800/40 bg-red-900/20 text-red-300'
                        : studyResultsNotice.tone === 'success'
                          ? 'border-green-800/40 bg-green-900/20 text-green-300'
                          : 'border-line bg-subtle text-body'
                    }`}
                  >
                    {studyResultsNotice.message}
                  </div>
                )}

                {studyResults.length === 0 && !studyResultsError ? (
                  <div className="rounded-xl border border-line bg-subtle px-4 py-6 text-center text-sm text-muted">
                    No study-tagged results yet.
                  </div>
                ) : filteredStudyResults.length === 0 ? (
                  <div className="rounded-xl border border-line bg-subtle px-4 py-6 text-center text-sm text-muted">
                    No study results match the current filters.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-line">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-subtle text-muted text-[11px] uppercase tracking-wider">
                        <tr>
                          <th className="px-3 py-3">Date</th>
                          <th className="px-3 py-3">Eye</th>
                          <th className="px-3 py-3">Test</th>
                          <th className="px-3 py-3">Study / session</th>
                          <th className="px-3 py-3">Participant</th>
                          <th className="px-3 py-3">Protocol</th>
                          <th className="px-3 py-3">Points</th>
                          <th className="px-3 py-3">Duration</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {filteredStudyResults.map(r => (
                          <tr key={`${r.userId}-${r.id}`} className="hover:bg-subtle-2">
                            <td className="px-3 py-2.5 text-body whitespace-nowrap">
                              {new Date(r.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                              <span className="text-muted ml-2">
                                {new Date(r.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-body">{r.eye}</td>
                            <td className="px-3 py-2.5 text-muted">{r.testType ?? '—'}</td>
                            <td className="px-3 py-2.5 text-xs">
                              <div className="font-mono text-body">{r.studyId ?? '—'}</div>
                              <div className="text-muted">{r.sessionId ?? 'no-session'}</div>
                            </td>
                            <td className="px-3 py-2.5 text-xs">
                              <div className="font-mono text-body">{r.participantId ?? '—'}</div>
                              <div className="text-muted">
                                visit {r.visitId ?? '—'}{r.repeatIndex != null ? ` · repeat ${r.repeatIndex}` : ''}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-xs">
                              <div className="font-mono text-body">{r.protocolId ?? '—'}</div>
                              <div className="text-muted">v{r.protocolVersion ?? '—'}</div>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-muted">
                              <span className="text-green-400">{r.detectedPoints}</span>
                              <span className="text-muted">/{r.totalPoints}</span>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-muted">
                              {r.durationSeconds != null ? `${Math.floor(r.durationSeconds / 60)}m ${(r.durationSeconds % 60).toString().padStart(2, '0')}s` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

interface SummaryRowProps {
  label: string
  value: string | null
  valueHint?: string
  action: string
  onAction: () => void
  optional?: boolean
}

function SummaryRow({ label, value, valueHint, action, onAction, optional }: SummaryRowProps) {
  const hasValue = !!value
  return (
    <div className={`rounded-xl border px-3 py-3 ${
      hasValue
        ? 'border-line bg-subtle'
        : optional
          ? 'border-line bg-white/[0.015]'
          : 'border-amber-500/20 bg-amber-500/10'
    }`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted">{label}</span>
        <button
          type="button"
          onClick={onAction}
          className="text-[11px] font-medium text-accent hover:text-accent-light underline decoration-dotted"
        >
          {action}
        </button>
      </div>
      <div className="mt-1.5 min-h-[2.5rem]">
        {hasValue ? (
          <>
            <p className="text-sm font-medium text-ink truncate">{value}</p>
            {valueHint && <p className="mt-0.5 text-[11px] text-muted truncate">{valueHint}</p>}
          </>
        ) : (
          <p className={`text-sm ${optional ? 'text-muted' : 'text-amber-200'}`}>
            {valueHint ?? (optional ? 'Optional' : 'Not selected')}
          </p>
        )}
      </div>
    </div>
  )
}

interface ProtocolFormProps {
  draft: {
    label: string
    studyId: string
    testType: TestType
    speedMode: RunSpeedMode
    extendedField: boolean
    staticGridPattern: StudyProfile['staticGridPattern']
    notes: string
    advancedMode: 'defaults' | 'current' | 'manual'
    manualAdvanced: AdvancedSettings
  }
  onChange: (next: ProtocolFormProps['draft']) => void
  onCancel: () => void
  onSubmit: () => void
}

function ProtocolForm({ draft, onChange, onCancel, onSubmit }: ProtocolFormProps) {
  const set = <K extends keyof ProtocolFormProps['draft']>(key: K, value: ProtocolFormProps['draft'][K]) => {
    onChange({ ...draft, [key]: value })
  }
  const speedOptions: RunSpeedMode[] = ['slow', 'normal']
  return (
    <div className="space-y-3 rounded-xl border border-line bg-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">New protocol</p>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-muted underline decoration-dotted hover:text-body"
        >
          cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Label</span>
          <input
            value={draft.label}
            onChange={e => set('label', e.target.value)}
            className="input-field"
            placeholder="e.g. Macular screening fast"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Study ID</span>
          <input
            value={draft.studyId}
            onChange={e => set('studyId', e.target.value)}
            className="input-field"
            placeholder="custom"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Test type</span>
          <div className="flex gap-1">
            {(['goldmann', 'static'] as const).map(value => {
              const selected = draft.testType === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => onChange({ ...draft, testType: value })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                    selected
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-line bg-subtle text-body hover:bg-subtle-2'
                  }`}
                >
                  {value === 'goldmann' ? 'Goldmann' : 'Static'}
                </button>
              )
            })}
          </div>
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Speed</span>
          <div className="flex gap-1">
            {speedOptions.map(value => {
              const selected = draft.speedMode === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => set('speedMode', value)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-semibold capitalize transition-colors ${
                    selected
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-line bg-subtle text-body hover:bg-subtle-2'
                  }`}
                >
                  {value}
                </button>
              )
            })}
          </div>
        </label>
        {draft.testType === 'goldmann' && (
          <label className="flex items-center gap-2 sm:col-span-2 text-sm text-body">
            <input
              type="checkbox"
              checked={draft.extendedField}
              onChange={e => set('extendedField', e.target.checked)}
              className="h-4 w-4 rounded accent-indigo-400"
            />
            Extended-field passes (2 extra shifted-fixation passes)
          </label>
        )}
        {draft.testType === 'static' && (
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Static grid</span>
            <select
              value={draft.staticGridPattern}
              onChange={e => set('staticGridPattern', e.target.value as StudyProfile['staticGridPattern'])}
              className="input-field"
            >
              {(['24-2', '30-2', '10-2', 'custom'] as const).map(p => (
                <option key={p} value={p}>{STATIC_GRID_INFO[p].label} — {STATIC_GRID_INFO[p].description}</option>
              ))}
            </select>
          </label>
        )}
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Notes (optional)</span>
          <textarea
            value={draft.notes}
            onChange={e => set('notes', e.target.value)}
            className="input-field min-h-[60px]"
            placeholder="Anything the operator should know before running this protocol."
          />
        </label>
        <div className="sm:col-span-2 space-y-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            Advanced settings
          </span>
          <div className="flex gap-1">
            {(
              [
                ['defaults', 'Defaults'],
                ['current', 'Use my current'],
                ['manual', 'Configure manually'],
              ] as const
            ).map(([mode, label]) => {
              const selected = draft.advancedMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => set('advancedMode', mode)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                    selected
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-line bg-subtle text-body hover:bg-subtle-2'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-muted">
            {draft.advancedMode === 'defaults' && 'Built-in defaults for timings, fixation alert, and catch trials.'}
            {draft.advancedMode === 'current' && 'Bakes in your current advanced settings (timings, fixation alert, catch trials).'}
            {draft.advancedMode === 'manual' && 'Set each option below. Seeded from your current settings.'}
          </p>
        </div>

        {draft.advancedMode === 'manual' && (
          <ManualAdvancedEditor
            value={draft.manualAdvanced}
            testType={draft.testType}
            onChange={next => set('manualAdvanced', next)}
          />
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-line bg-subtle px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-subtle-2"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={draft.label.trim().length === 0}
          className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
            draft.label.trim().length === 0
              ? 'cursor-not-allowed bg-subtle-2 text-muted'
              : 'bg-accent text-white hover:bg-accent-light'
          }`}
        >
          Create and select
        </button>
      </div>
    </div>
  )
}

interface ManualAdvancedEditorProps {
  value: AdvancedSettings
  testType: TestType
  onChange: (next: AdvancedSettings) => void
}

function ManualAdvancedEditor({ value, testType, onChange }: ManualAdvancedEditorProps) {
  const update = <K extends keyof AdvancedSettings>(key: K, next: AdvancedSettings[K]) => {
    onChange({ ...value, [key]: next })
  }
  const updateSpeed = (
    field: 'stimulusMs' | 'responseMs' | 'gapMinMs' | 'gapMaxMs',
    n: number,
  ) => onChange({ ...value, speedPreset: { ...value.speedPreset, [field]: n } })

  return (
    <div className="sm:col-span-2 space-y-3 rounded-lg border border-line bg-subtle p-3 text-xs text-muted">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={value.initialBlindspotCheck}
          onChange={e => update('initialBlindspotCheck', e.target.checked)}
          className="h-3.5 w-3.5 rounded accent-indigo-400"
        />
        <span className="text-body">Blindspot check before test</span>
      </label>

      {testType === 'goldmann' && (
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={value.measureReactionTime}
            onChange={e => update('measureReactionTime', e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-indigo-400"
          />
          <span className="text-body">Measure reaction time (Goldmann calibration)</span>
        </label>
      )}

      <div className="space-y-1">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={value.catchTrialsEnabled}
            onChange={e => update('catchTrialsEnabled', e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-indigo-400"
          />
          <span className="text-body">Blindspot catch trials</span>
        </label>
        {value.catchTrialsEnabled && (
          <label className="block pl-5 space-y-1">
            <span className="text-muted">
              Cadence <span className="text-muted">(1 catch trial every N presentations)</span>
            </span>
            <input
              type="number"
              min={1}
              max={50}
              value={value.catchTrialEveryN}
              onChange={e => {
                const n = Number(e.target.value)
                if (Number.isInteger(n) && n >= 1 && n <= 50) update('catchTrialEveryN', n)
              }}
              className="w-24 rounded border border-line bg-surface px-2 py-1 font-mono text-ink"
            />
          </label>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="block text-body">Fixation-alert duration <span className="text-muted">(ms; 0 = off)</span></span>
          <input
            type="number"
            min={0}
            max={5000}
            step={100}
            value={value.fixationAlertMs}
            onChange={e => {
              const n = Number(e.target.value)
              if (Number.isInteger(n) && n >= 0 && n <= 5000) update('fixationAlertMs', n)
            }}
            className="w-24 rounded border border-line bg-surface px-2 py-1 font-mono text-ink"
          />
        </label>
        <label className="block space-y-1">
          <span className="block text-body">Fixation-alert message</span>
          <input
            type="text"
            maxLength={200}
            value={value.fixationAlertMessage}
            onChange={e => update('fixationAlertMessage', e.target.value)}
            className="w-full rounded border border-line bg-surface px-2 py-1 text-ink"
          />
        </label>
      </div>

      <fieldset className="space-y-1">
        <legend className="text-body">Background shade</legend>
        <div className="flex gap-3 pt-1">
          {(['dark', 'medium', 'light'] as const).map(shade => (
            <label key={shade} className="flex items-center gap-1.5 capitalize">
              <input
                type="radio"
                name="manual-bg-shade"
                value={shade}
                checked={value.backgroundShade === shade}
                onChange={() => update('backgroundShade', shade)}
                className="accent-amber-500"
              />
              {shade}
            </label>
          ))}
        </div>
      </fieldset>

      {testType === 'static' && (
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.speedPreset.override}
              onChange={e => onChange({
                ...value,
                speedPreset: { ...value.speedPreset, override: e.target.checked },
              })}
              className="accent-amber-500"
            />
            <span className="text-body">Override speed-preset timings (Static)</span>
          </label>
          <div className="grid grid-cols-2 gap-2 pl-6">
            {(['stimulusMs', 'responseMs', 'gapMinMs', 'gapMaxMs'] as const).map(f => (
              <label key={f} className="space-y-1">
                <span className="block text-[11px] text-muted">{f}</span>
                <input
                  type="number"
                  min={0}
                  max={5000}
                  step={10}
                  value={value.speedPreset[f]}
                  disabled={!value.speedPreset.override}
                  onChange={e => {
                    const n = Number(e.target.value)
                    if (Number.isInteger(n) && n >= 0 && n <= 5000) updateSpeed(f, n)
                  }}
                  className="w-full rounded border border-line bg-surface px-2 py-1 font-mono text-ink disabled:opacity-50"
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface ScreenSetupWizardProps {
  step: WizardStep
  draft: WizardDraft
  onCancel: () => void
  onAdvance: (next: WizardStep, patch?: Partial<WizardDraft>) => void
  onFinish: (draft: WizardDraft) => void
}

function ScreenSetupWizard({ step, draft, onCancel, onAdvance, onFinish }: ScreenSetupWizardProps) {
  const [cardWidthPx, setCardWidthPx] = useState(draft.cardWidthPx)
  const [distanceCm, setDistanceCm] = useState<number | ''>(draft.viewingDistanceCm ?? '')
  // Default the skip toggle OFF for fresh workstations (and editing
  // an entry that already has a saved value), so the input field is
  // visible immediately instead of hidden behind a pre-checked "skip
  // this step" box. Clinicians can still tick it if they really want
  // the per-test prompt.
  const [skipDistance, setSkipDistance] = useState(false)
  const [brightness, setBrightness] = useState<number>(draft.brightnessFloor ?? 0.04)
  const [skipBrightness, setSkipBrightness] = useState(false)
  const [label, setLabel] = useState(draft.label)

  const stepNumber = step === 'card' ? 1 : step === 'distance' ? 2 : step === 'brightness' ? 3 : 4

  return (
    <div className="space-y-4 rounded-xl border border-line bg-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
          {draft.editingId ? 'Recalibrate workstation' : 'New workstation'} · step {stepNumber} of 4
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-muted underline decoration-dotted hover:text-body"
        >
          cancel
        </button>
      </div>

      {step === 'card' && (
        <div className="space-y-3">
          <h3 className="text-base font-heading font-semibold">Screen size</h3>
          <p className="text-sm text-muted">
            Hold a bank card flat against the screen and drag the slider until the rectangle exactly matches the card.
          </p>
          <div className="flex justify-center">
            <div
              className="border-2 border-dashed border-accent rounded-lg flex items-center justify-center text-accent-light text-xs"
              style={{
                width: cardWidthPx,
                height: cardWidthPx * (CREDIT_CARD_HEIGHT_MM / CREDIT_CARD_WIDTH_MM),
              }}
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
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => onAdvance('distance', { cardWidthPx })}
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-light"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 'distance' && (
        <div className="space-y-3">
          <h3 className="text-base font-heading font-semibold">Viewing distance</h3>
          <p className="text-sm text-muted">
            If this workstation has a fixed chin-rest distance, save it here. Otherwise the per-test calibration will still prompt for distance.
          </p>
          <label className="flex items-center gap-2 text-sm text-body">
            <input
              type="checkbox"
              checked={skipDistance}
              onChange={e => setSkipDistance(e.target.checked)}
              className="h-4 w-4 rounded accent-indigo-400"
            />
            No fixed distance — ask each test
          </label>
          {!skipDistance && (
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={20}
                max={100}
                step={1}
                value={distanceCm}
                onChange={e => setDistanceCm(e.target.value === '' ? '' : Number(e.target.value))}
                className="input-field w-28"
                placeholder="50"
              />
              <span className="text-sm text-muted">cm</span>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => onAdvance('card')}
              className="rounded-xl border border-line bg-subtle px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-subtle-2"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => {
                const value = skipDistance || distanceCm === '' ? undefined : Math.max(20, Math.min(100, Number(distanceCm)))
                onAdvance('brightness', { viewingDistanceCm: value })
              }}
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-light"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 'brightness' && (
        <div className="space-y-3">
          <h3 className="text-base font-heading font-semibold">Brightness floor</h3>
          <p className="text-sm text-muted">
            If the room lighting and monitor brightness are controlled, save the dimmest visible dot here. Otherwise leave the toggle on and each test will prompt.
          </p>
          <label className="flex items-center gap-2 text-sm text-body">
            <input
              type="checkbox"
              checked={skipBrightness}
              onChange={e => setSkipBrightness(e.target.checked)}
              className="h-4 w-4 rounded accent-indigo-400"
            />
            No fixed brightness — ask each test
          </label>
          {!skipBrightness && (
            <div className="space-y-3">
              {/* Dark preview box: the dot is semi-transparent white, so a
                  light background would make it invisible (mirrors the dim
                  test surface). */}
              <div className="relative w-full h-32 bg-black rounded-xl border border-slate-800 flex items-center justify-center">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: `rgba(255, 255, 255, ${brightness})` }}
                />
                <span className="absolute top-2 right-3 text-xs text-muted font-mono">
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
            </div>
          )}
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => onAdvance('distance')}
              className="rounded-xl border border-line bg-subtle px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-subtle-2"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => onAdvance('name', {
                brightnessFloor: skipBrightness ? undefined : brightness,
              })}
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-light"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 'name' && (
        <div className="space-y-3">
          <h3 className="text-base font-heading font-semibold">Name this workstation</h3>
          <p className="text-sm text-muted">
            Give it a label so you can tell it apart from other workstations (e.g. "Clinic A · Station 3").
          </p>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            className="input-field"
            placeholder="Workstation name"
          />
          <div className="rounded-xl border border-line bg-subtle p-3 text-xs text-muted space-y-1">
            <p>Card width: <span className="text-ink font-mono">{draft.cardWidthPx.toFixed(0)} px</span></p>
            <p>Distance: {draft.viewingDistanceCm != null ? <span className="text-ink font-mono">{draft.viewingDistanceCm} cm</span> : <span className="text-muted">per-test</span>}</p>
            <p>Brightness: {draft.brightnessFloor != null ? <span className="text-ink font-mono">{(draft.brightnessFloor * 100).toFixed(1)}%</span> : <span className="text-muted">per-test</span>}</p>
          </div>
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => onAdvance('brightness')}
              className="rounded-xl border border-line bg-subtle px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-subtle-2"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => onFinish({ ...draft, label })}
              disabled={label.trim().length === 0}
              className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
                label.trim().length === 0
                  ? 'cursor-not-allowed bg-subtle-2 text-muted'
                  : 'bg-accent text-white hover:bg-accent-light'
              }`}
            >
              {draft.editingId ? 'Save changes' : 'Save workstation'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
