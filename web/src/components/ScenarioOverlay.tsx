/**
 * Overlay component that lets users compare their results against
 * clinical reference scenarios. Shows a toggleable side-by-side or
 * overlaid comparison with severity benchmarks.
 */
import { useState, useMemo } from 'react'
import { getAllScenarios } from '../testFixtures'
import { calcIsopterAreas } from '../isopterCalc'
import type { TestPoint, StimulusKey } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'

interface Props {
  /** The user's actual test points */
  userPoints: TestPoint[]
  /** Pre-computed areas from the user's points */
  userAreas: Partial<Record<StimulusKey, number>>
  /** Max eccentricity used in the test */
  maxEccentricity: number
}

export function ScenarioOverlay({ userAreas }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const scenarios = useMemo(() => getAllScenarios(), [])
  const scenarioAreas = useMemo(() =>
    scenarios.map(s => ({ ...s, areas: calcIsopterAreas(s.points) })),
    [scenarios],
  )

  // Find closest scenario based on III4e area (or V4e fallback)
  const closestIdx = useMemo(() => {
    const userKey: StimulusKey = userAreas['III4e'] != null ? 'III4e' : 'V4e'
    const userArea = userAreas[userKey]
    if (userArea == null) return 0

    let bestIdx = 0
    let bestDist = Infinity
    scenarioAreas.forEach((s, i) => {
      const sArea = s.areas[userKey]
      if (sArea != null) {
        const dist = Math.abs(sArea - userArea)
        if (dist < bestDist) {
          bestDist = dist
          bestIdx = i
        }
      }
    })
    return bestIdx
  }, [userAreas, scenarioAreas])

  const selected = selectedId
    ? scenarioAreas.find(s => s.id === selectedId) ?? scenarioAreas[closestIdx]
    : scenarioAreas[closestIdx]

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full py-3 bg-gray-900 hover:bg-gray-800 rounded-xl font-medium transition-colors border border-gray-800 hover:border-gray-700 text-sm"
      >
        <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M3 12h4l3-9 4 18 3-9h4" />
        </svg>
        Compare with clinical scenarios
      </button>
    )
  }

  return (
    <div className="space-y-4 bg-gray-900/50 rounded-2xl p-4 border border-gray-800">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">Clinical comparison</h3>
        <button
          onClick={() => setExpanded(false)}
          className="text-gray-500 hover:text-gray-300 text-xs transition-colors"
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
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
            >
              {s.label}
              {isClosest && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-yellow-400 rounded-full" title="Closest match" />
              )}
            </button>
          )
        })}
      </div>

      {/* Selected scenario info */}
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
            selected.severity === 'Normal' ? 'bg-green-500/20 text-green-400' :
            selected.severity === 'Mild' ? 'bg-yellow-500/20 text-yellow-400' :
            selected.severity.startsWith('Moderate') ? 'bg-orange-500/20 text-orange-400' :
            selected.severity === 'Severe' ? 'bg-red-500/20 text-red-400' :
            'bg-red-600/20 text-red-500'
          }`}>
            {selected.severity}
          </span>
          <p className="text-xs text-gray-400 leading-relaxed">{selected.description}</p>
        </div>

        {/* Area comparison table */}
        <div className="overflow-hidden rounded-lg border border-gray-800">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-800/50">
                <th className="text-left py-1.5 px-2 text-gray-500 font-medium">Isopter</th>
                <th className="text-right py-1.5 px-2 text-gray-500 font-medium">Your result</th>
                <th className="text-right py-1.5 px-2 text-gray-500 font-medium">{selected.label}</th>
                <th className="text-right py-1.5 px-2 text-gray-500 font-medium">Diff</th>
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
                  <tr key={key} className="border-t border-gray-800/50">
                    <td className="py-1.5 px-2">
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STIMULI[key].color }} />
                        <span className="text-gray-300">{key}</span>
                      </span>
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono text-gray-300">
                      {userArea != null ? `${userArea.toFixed(0)}°²` : '—'}
                    </td>
                    <td className="text-right py-1.5 px-2 font-mono text-gray-400">
                      {refArea != null ? `${refArea.toFixed(0)}°²` : '—'}
                    </td>
                    <td className={`text-right py-1.5 px-2 font-mono ${
                      diff == null ? 'text-gray-600'
                        : diff > 0 ? 'text-green-400'
                        : diff < -100 ? 'text-red-400'
                        : 'text-yellow-400'
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
          <p className="text-xs text-gray-600 uppercase tracking-wider">Radius comparison (V4e)</p>
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
                  <span className="text-xs text-gray-400 w-14 shrink-0">You</span>
                  <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all"
                      style={{ width: `${(userR / barMax) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-400 font-mono w-10 text-right">
                    {userR > 0 ? `${userR.toFixed(0)}°` : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-14 shrink-0 truncate">{selected.label}</span>
                  <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gray-500 rounded-full transition-all"
                      style={{ width: `${(refR / barMax) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-400 font-mono w-10 text-right">
                    {refR > 0 ? `${refR.toFixed(0)}°` : '—'}
                  </span>
                </div>
              </div>
            )
          })()}
        </div>

        {closestIdx === scenarioAreas.indexOf(selected) && (
          <p className="text-xs text-yellow-400/70 flex items-center gap-1">
            <span className="w-1.5 h-1.5 bg-yellow-400 rounded-full" />
            Closest match to your results
          </p>
        )}
      </div>
    </div>
  )
}
