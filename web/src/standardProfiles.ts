/**
 * Built-in clinician profile presets.
 *
 * These are valid {@link StudyProfile} instances bundled with the app so a
 * clinician can pick a sensible test configuration without authoring a
 * JSON file.
 *
 * Naming convention: `id` is `standard.<short-slug>`; `studyId` is the
 * literal `'standard'` so analytics and OVFX exports can recognise built-
 * ins versus real research-study imports. Versioning follows the same
 * vfcStudyProfileVersion 1.x scheme as imported profiles — bump when a
 * preset's defaults change in a way that would alter results.
 *
 * Inspired by the protocol templates that ship with Specvis-Desktop's
 * `Settings/` folder; see the README for the full lineage.
 */
import { DEFAULT_ADVANCED_SETTINGS } from './advancedSettings'
import { CUSTOM_GRID_PRESETS } from './grids'
import type { StudyProfile } from './studyMode'

const SHARED_VERSION = '1.0.0'

const SPECVIS_SUPERFAST_SETTINGS = {
  ...DEFAULT_ADVANCED_SETTINGS,
  speedPreset: {
    override: true,
    stimulusMs: 200,
    responseMs: 1000,
    gapMinMs: 700,
    gapMaxMs: 900,
  },
  backgroundShade: 'medium' as const,
  staticGridPattern: 'custom' as const,
  customGrid: { ...CUSTOM_GRID_PRESETS.screening },
}

const SPECVIS_DESKTOP_DEFAULT_SETTINGS = {
  ...DEFAULT_ADVANCED_SETTINGS,
  speedPreset: {
    override: true,
    stimulusMs: 200,
    responseMs: 1000,
    gapMinMs: 1000,
    gapMaxMs: 1200,
  },
  backgroundShade: 'dark' as const,
  staticGridPattern: 'custom' as const,
  customGrid: {
    spacingXDeg: 4,
    spacingYDeg: 4,
    extentXDeg: 32,
    extentYDeg: 20,
  },
}

export const STANDARD_PROFILES: StudyProfile[] = [
  {
    id: 'standard.static-48p-fast',
    label: 'Rapid 48-point screen',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'static',
    speedMode: 'normal',
    extendedField: false,
    staticGridPattern: 'custom',
    advancedSettings: {
      ...SPECVIS_SUPERFAST_SETTINGS,
      initialBlindspotCheck: false,
      catchTrialsEnabled: false,
    },
    notes: '48-point white-on-white static screen with a 200 ms stimulus and 700-900 ms interval.',
  },
  {
    id: 'standard.static-48p-fixation',
    label: 'Rapid 48-point + fixation',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'static',
    speedMode: 'normal',
    extendedField: false,
    staticGridPattern: 'custom',
    advancedSettings: {
      ...SPECVIS_SUPERFAST_SETTINGS,
      initialBlindspotCheck: true,
      catchTrialsEnabled: true,
      catchTrialEveryN: 10,
    },
    notes: 'Rapid 48-point static screen with blindspot fixation checks every 10 stimuli.',
  },
  {
    id: 'standard.static-48p-fixation-alert',
    label: 'Rapid 48-point + alert',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'static',
    speedMode: 'normal',
    extendedField: false,
    staticGridPattern: 'custom',
    advancedSettings: {
      ...SPECVIS_SUPERFAST_SETTINGS,
      initialBlindspotCheck: true,
      catchTrialsEnabled: true,
      catchTrialEveryN: 10,
      fixationAlertMs: 1000,
      fixationAlertMessage: '!',
    },
    notes: 'Rapid 48-point static screen with fixation checks and a brief fixation-loss alert.',
  },
  {
    id: 'standard.static-4deg-screen',
    label: 'Desktop 4° static grid',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'static',
    speedMode: 'slow',
    extendedField: false,
    staticGridPattern: 'custom',
    advancedSettings: {
      ...SPECVIS_DESKTOP_DEFAULT_SETTINGS,
      initialBlindspotCheck: false,
      catchTrialsEnabled: false,
    },
    notes: 'Dense 4° static grid with a 200 ms stimulus and 1000-1200 ms interval.',
  },
  {
    id: 'standard.goldmann',
    label: 'Goldmann standard',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'goldmann',
    speedMode: 'normal',
    extendedField: false,
    staticGridPattern: '24-2',
    advancedSettings: {
      ...DEFAULT_ADVANCED_SETTINGS,
      initialBlindspotCheck: true,
      catchTrialsEnabled: true,
    },
    notes: 'Three-isopter kinetic exam (III4e + I4e + I2e) at the normal shorter pace. Pre-flight blindspot check and in-test catch trials on.',
  },
  {
    id: 'standard.goldmann-slow',
    label: 'Goldmann slow',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'goldmann',
    speedMode: 'slow',
    extendedField: false,
    staticGridPattern: '24-2',
    advancedSettings: {
      ...DEFAULT_ADVANCED_SETTINGS,
      initialBlindspotCheck: true,
      catchTrialsEnabled: true,
    },
    notes: 'Longer kinetic exam with slower timing and the denser central-sensitivity pass.',
  },
  {
    id: 'standard.goldmann-rp',
    label: 'Goldmann RP screen',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'goldmann',
    speedMode: 'normal',
    extendedField: true,
    staticGridPattern: '24-2',
    advancedSettings: {
      ...DEFAULT_ADVANCED_SETTINGS,
      initialBlindspotCheck: true,
      catchTrialsEnabled: true,
    },
    notes: 'Extended-field kinetic exam for retinitis-pigmentosa monitoring at the normal shorter pace.',
  },
  {
    id: 'standard.goldmann-rp-slow',
    label: 'Goldmann RP slow',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'goldmann',
    speedMode: 'slow',
    extendedField: true,
    staticGridPattern: '24-2',
    advancedSettings: {
      ...DEFAULT_ADVANCED_SETTINGS,
      initialBlindspotCheck: true,
      catchTrialsEnabled: true,
    },
    notes: 'Extended-field RP kinetic exam with slower timing and the denser central-sensitivity pass.',
  },
  {
    id: 'standard.static-24-2',
    label: 'Static 24-2',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'static',
    speedMode: 'slow',
    extendedField: false,
    staticGridPattern: '24-2',
    advancedSettings: {
      ...DEFAULT_ADVANCED_SETTINGS,
      staticGridPattern: '24-2',
      initialBlindspotCheck: true,
      catchTrialsEnabled: true,
    },
    notes: '54-point HFA-style central grid. The most common clinical static pattern.',
  },
  {
    id: 'standard.static-30-2',
    label: 'Static 30-2',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'static',
    speedMode: 'slow',
    extendedField: false,
    staticGridPattern: '30-2',
    advancedSettings: {
      ...DEFAULT_ADVANCED_SETTINGS,
      staticGridPattern: '30-2',
      initialBlindspotCheck: true,
      catchTrialsEnabled: true,
    },
    notes: '76-point grid with wider peripheral coverage. Preferred for RP monitoring.',
  },
  {
    id: 'standard.static-10-2',
    label: 'Static 10-2',
    studyId: 'standard',
    version: SHARED_VERSION,
    testType: 'static',
    speedMode: 'slow',
    extendedField: false,
    staticGridPattern: '10-2',
    advancedSettings: {
      ...DEFAULT_ADVANCED_SETTINGS,
      staticGridPattern: '10-2',
      initialBlindspotCheck: true,
      catchTrialsEnabled: true,
    },
    notes: '68-point central macular grid. For advanced RP or macular cases where only the central island remains.',
  },
]
