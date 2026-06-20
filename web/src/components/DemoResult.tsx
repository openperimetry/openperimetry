import { useMemo } from 'react'
import type { TestResult } from '../types'
import { getAllScenarios } from '../testFixtures'
import { BackButton } from './AccessibleNav'
import { GoldmannResults } from './GoldmannResults'
import { HFAResultsView } from './HFAResultsView'
import { ClinicalDisclaimer } from './ClinicalDisclaimer'
import { calcIsopterAreas } from '../isopterCalc'
import { exportTrackedResultPDF } from '../pdfExportTracking'
import { adjacentScenarioId, type DemoMode } from '../demoRoute'
import { severityBadgeClass } from '../severityBadge'

/** Static 24-2 reaches ~28°; a 30° plot extent suits the greyscale overlay
 *  (not the Goldmann 50°). Mirrors the old demo's STATIC_MAX_ECC_DEG. */
const DEMO_STATIC_MAX_ECC_DEG = 30

interface Props {
  scenarioId: string
  mode: DemoMode
  /** Back to the scenario picker. */
  onBack: () => void
  /** Navigate to a scenario + mode (toggle and prev/next). */
  onNavigate: (id: string, mode: DemoMode) => void
}

function tabClass(active: boolean): string {
  return `px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
    active ? 'bg-accent text-white' : 'text-muted hover:text-ink'
  }`
}

/** One clinical scenario as the genuine results screen, with a Goldmann/Static
 *  toggle. Goldmann body reuses GoldmannResults (no map calibration / verify);
 *  static body renders the real HFAResultsView. */
export function DemoResult({ scenarioId, mode, onBack, onNavigate }: Props) {
  const scenarios = useMemo(() => getAllScenarios(), [])
  const scenario = scenarios.find(s => s.id === scenarioId)

  if (!scenario) {
    return (
      <div className="min-h-[100dvh] bg-base text-body safe-pad p-6 animate-page-in">
        <main className="mx-auto max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-heading font-bold">Scenario not found</h1>
          <p className="text-sm text-muted">No demo scenario matches “{scenarioId}”.</p>
          <button
            onClick={onBack}
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-dark transition-colors"
          >
            Back to scenarios
          </button>
        </main>
      </div>
    )
  }

  const ids = scenarios.map(s => s.id)
  const prevId = adjacentScenarioId(ids, scenarioId, -1)
  const nextId = adjacentScenarioId(ids, scenarioId, 1)
  const staticPoints = scenario.staticPoints ?? []

  const handleExport = () => {
    const base = {
      id: scenario.id,
      eye: 'right' as const,
      date: new Date().toISOString(),
      calibration: scenario.calibration,
      durationSeconds: 0,
    }
    const result: TestResult =
      mode === 'static'
        ? {
            ...base,
            points: staticPoints,
            isopterAreas: calcIsopterAreas(staticPoints),
            testType: 'static',
            testMode: 'threshold',
          }
        : {
            ...base,
            points: scenario.points,
            isopterAreas: calcIsopterAreas(scenario.points),
            testType: 'goldmann',
          }
    exportTrackedResultPDF(result, { isDemo: true }, 'result_screen')
  }

  const footer = (
    <div className="space-y-3">
      <div className="flex gap-3">
        <button
          onClick={() => prevId && onNavigate(prevId, mode)}
          className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg font-medium transition-colors"
        >
          ← Previous
        </button>
        <button
          onClick={() => nextId && onNavigate(nextId, mode)}
          className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg font-medium transition-colors"
        >
          Next →
        </button>
      </div>
      <button
        onClick={handleExport}
        className="w-full py-3 btn-primary rounded-xl font-medium text-white"
      >
        Export PDF
      </button>
    </div>
  )

  return (
    <div className="min-h-[100dvh] bg-base text-body p-6 overflow-y-auto animate-page-in">
      <div className="max-w-lg mx-auto mb-3 flex items-center justify-between gap-3">
        <BackButton onClick={onBack} label="Scenarios" />
        <span className={severityBadgeClass(scenario.severity)}>{scenario.severity}</span>
      </div>
      <p className="max-w-lg mx-auto text-center text-sm text-muted mb-3">
        <span className="font-medium text-body">{scenario.label}</span> — {scenario.description}
      </p>
      <div className="max-w-lg mx-auto mb-4 flex justify-center">
        <div role="tablist" aria-label="Test type" className="inline-flex rounded-xl border border-line bg-surface p-1">
          <button
            role="tab"
            aria-selected={mode === 'goldmann'}
            onClick={() => onNavigate(scenarioId, 'goldmann')}
            className={tabClass(mode === 'goldmann')}
          >
            Goldmann
          </button>
          <button
            role="tab"
            aria-selected={mode === 'static'}
            onClick={() => onNavigate(scenarioId, 'static')}
            className={tabClass(mode === 'static')}
          >
            Static
          </button>
        </div>
      </div>

      {mode === 'goldmann' ? (
        <GoldmannResults
          points={scenario.points}
          eye="right"
          maxEccentricityDeg={scenario.maxEccentricity}
          calibration={scenario.calibration}
          showTruncation={false}
          footer={footer}
        />
      ) : (
        <main className="max-w-lg mx-auto space-y-6 pb-12">
          <HFAResultsView
            points={staticPoints}
            eye="right"
            gridPattern="24-2"
            date={new Date().toISOString()}
            brightnessFloor={scenario.calibration.brightnessFloor}
            maxEccentricityDeg={DEMO_STATIC_MAX_ECC_DEG}
            showReliability={false}
          />
          <ClinicalDisclaimer variant="results" />
          {footer}
        </main>
      )}
    </div>
  )
}
