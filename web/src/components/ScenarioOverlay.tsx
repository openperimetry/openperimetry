/**
 * Overlay component that lets users compare their results against
 * clinical reference scenarios. Shows a toggleable side-by-side or
 * overlaid comparison with severity benchmarks.
 */
import { useState, useMemo } from 'react'
import { getAllScenarios } from '../testFixtures'
import { calcIsopterAreas } from '../isopterCalc'
import { scoreField, type FieldSeverity } from '../clinicalClassifications'
import { detectFieldPatterns } from '../fieldAnalysis'
import type { TestPoint, StimulusKey, CalibrationData } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'

// Severity and pattern are orthogonal axes: the comparison holds only the base
// STAGES; pattern findings (ring scotoma, asymmetry) are additive modifiers,
// surfaced as tags rather than competing scenarios.
const STAGE_IDS = ['normal', 'early-rp', 'moderate-rp', 'severe-rp', 'very-severe-rp']
const SEVERITY_TO_STAGE_ID: Record<FieldSeverity, string> = {
  normal: 'normal',
  borderline: 'normal',
  mild: 'early-rp',
  moderate: 'moderate-rp',
  severe: 'severe-rp',
  'very-severe': 'very-severe-rp',
}

interface Props {
  /** The user's actual test points */
  userPoints: TestPoint[]
  /** Pre-computed areas from the user's points */
  userAreas: Partial<Record<StimulusKey, number>>
  /** Max eccentricity used in the test */
  maxEccentricity: number
  /** Calibration, so the closest stage matches the headline field score. */
  calibration?: CalibrationData
}

export function ScenarioOverlay({ userPoints, userAreas, maxEccentricity, calibration }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Only the base-stage scenarios are pickable references.
  const scenarioAreas = useMemo(() => {
    const byId = new Map(getAllScenarios().map(s => [s.id, s]))
    return STAGE_IDS
      .map(id => byId.get(id))
      .filter((s): s is NonNullable<typeof s> => s != null)
      .map(s => ({ ...s, areas: calcIsopterAreas(s.points) }))
  }, [])

  // The closest stage IS the headline field-score stage, so the comparison and
  // the Interpretation panel never disagree.
  const closestIdx = useMemo(() => {
    const fs = scoreField(userAreas, maxEccentricity, calibration)
    const stageId = fs ? SEVERITY_TO_STAGE_ID[fs.band.severity] : 'normal'
    const idx = scenarioAreas.findIndex(s => s.id === stageId)
    return idx >= 0 ? idx : 0
  }, [userAreas, maxEccentricity, calibration, scenarioAreas])

  // Detected pattern modifiers (ring scotoma, asymmetry) — additive tags.
  const modifiers = useMemo(() => detectFieldPatterns(userPoints, userAreas), [userPoints, userAreas])

  const selected = selectedId
    ? scenarioAreas.find(s => s.id === selectedId) ?? scenarioAreas[closestIdx]
    : scenarioAreas[closestIdx]

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full py-3 bg-surface hover:bg-subtle rounded-xl font-medium transition-colors border border-line hover:border-accent/50 text-sm text-body"
      >
        <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M3 12h4l3-9 4 18 3-9h4" />
        </svg>
        Compare with clinical scenarios
      </button>
    )
  }

  return (
    <div className="space-y-4 bg-subtle rounded-2xl p-4 border border-line">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Clinical comparison</h3>
        <button
          onClick={() => setExpanded(false)}
          className="text-muted hover:text-ink text-xs transition-colors"
        >
          Close
        </button>
      </div>

      {/* Scenario picker */}
      <div className="flex gap-1.5 flex-wrap">
        {scenarioAreas.map((s, i) => {
          const isSelected = s.id === selected.id
          const isClosest = i === closestIdx
          return (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors relative ${
                isSelected
                  ? 'bg-accent text-white'
                  : 'bg-surface text-body border border-line hover:bg-subtle-2 hover:text-ink'
              }`}
            >
              {s.label}
              {isClosest && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full" title="Closest match" />
              )}
            </button>
          )
        })}
      </div>

      {/* Detected pattern modifiers — additive classifiers that sit on top of
          the base stage (e.g. "Moderate" + ring scotoma + asymmetric). */}
      {modifiers.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <span className="text-muted">Modifiers:</span>
          {modifiers.map(m => (
            <span key={m.key} className="px-2 py-0.5 rounded-full bg-subtle-2 text-body border border-line">
              {m.label}
            </span>
          ))}
        </div>
      )}

      {/* Selected scenario info */}
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
            selected.severity === 'Normal' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200' :
            selected.severity === 'Mild' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200' :
            selected.severity.startsWith('Moderate') ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200' :
            selected.severity === 'Severe' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200' :
            'bg-red-200 text-red-800 dark:bg-red-900/50 dark:text-red-200'
          }`}>
            {selected.severity}
          </span>
          <p className="text-xs text-body leading-relaxed">{selected.description}</p>
        </div>

        {/* Area comparison table */}
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-subtle-2">
                <th className="text-left py-1.5 px-2 text-muted font-medium">Isopter</th>
                <th className="text-right py-1.5 px-2 text-muted font-medium">Your result</th>
                <th className="text-right py-1.5 px-2 text-muted font-medium">{selected.label}</th>
                <th className="text-right py-1.5 px-2 text-muted font-medium">Diff</th>
              </tr>
            </thead>
            <tbody>
              {ISOPTER_ORDER.map(key => {
                const userArea = userAreas[key]
                const refArea = selected.areas[key]
                if (userArea == null && refArea == null) return null

                const diff = (userArea != null && refArea != null)
                  ? userArea - refArea
                  : null

                return (
                  <tr key={key} className="border-t border-line">
                    <td className="py-1.5 px-2">
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STIMULI[key].color }} />
                        <span className="text-ink">{key}</span>
                      </span>
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono text-ink">
                      {userArea != null ? `${userArea.toFixed(0)}°²` : '—'}
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono text-body">
                      {refArea != null ? `${refArea.toFixed(0)}°²` : '—'}
                    </td>
                    <td className={`text-right py-1.5 px-2 font-mono ${
                      diff == null ? 'text-muted'
                        : diff > 0 ? 'text-green-600 dark:text-green-400'
                        : diff < -100 ? 'text-red-600 dark:text-red-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}>
                      {diff != null ? `${diff > 0 ? '+' : ''}${diff.toFixed(0)}°²` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Visual bar chart comparison */}
        <div className="space-y-1.5 pt-1">
          <p className="text-xs text-muted uppercase tracking-wider">Radius comparison (V4e)</p>
          {(() => {
            const userV4e = userAreas['V4e']
            const refV4e = selected.areas['V4e']
            const maxArea = Math.max(userV4e ?? 0, refV4e ?? 0, 1)
            const maxRadius = Math.sqrt(maxArea / Math.PI)
            const normalRadius = Math.sqrt((scenarioAreas[0].areas['V4e'] ?? 9000) / Math.PI)
            const barMax = Math.max(maxRadius, normalRadius) * 1.1

            const userR = userV4e != null ? Math.sqrt(userV4e / Math.PI) : 0
            const refR = refV4e != null ? Math.sqrt(refV4e / Math.PI) : 0

            return (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-body w-14 shrink-0">You</span>
                  <div className="flex-1 h-3 bg-subtle-2 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all"
                      style={{ width: `${(userR / barMax) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-body font-mono w-10 text-right">
                    {userR > 0 ? `${userR.toFixed(0)}°` : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-body w-14 shrink-0 truncate">{selected.label}</span>
                  <div className="flex-1 h-3 bg-subtle-2 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-muted rounded-full transition-all"
                      style={{ width: `${(refR / barMax) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-body font-mono w-10 text-right">
                    {refR > 0 ? `${refR.toFixed(0)}°` : '—'}
                  </span>
                </div>
              </div>
            )
          })()}
        </div>

        {closestIdx === scenarioAreas.indexOf(selected) && (
          <p className="text-xs text-amber-600 flex items-center gap-1">
            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
            Closest match to your results
          </p>
        )}
      </div>
    </div>
  )
}
