/**
 * Demo page for visual verification of clinical scenarios.
 * Shows radar maps, vision simulations, and interpretation for each severity level.
 * Heavy components are lazy-rendered on scroll for performance.
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import { getAllScenarios } from '../testFixtures'
import { BackButton } from './AccessibleNav'
import { VisualFieldMap } from './VisualFieldMap'
import { calcIsopterAreas } from '../isopterCalc'
import { Interpretation } from './Interpretation'
import { VisionSimulator } from './VisionSimulator'
import { exportResultPDF } from '../pdfExport'
import { STIMULI, ISOPTER_ORDER } from '../types'
import type { TestResult } from '../types'

interface Props {
  onBack: () => void
}

/** Renders children only once the element scrolls near the viewport */
function LazySection({ children, minHeight = 360 }: { children: React.ReactNode; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref}>
      {visible ? children : <div style={{ minHeight }} className="flex items-center justify-center text-zinc-600 text-sm">Scroll to load…</div>}
    </div>
  )
}

function ScenarioCard({ scenario, mapSize }: { scenario: ReturnType<typeof getAllScenarios>[number]; mapSize: number }) {
  const areas = useMemo(() => calcIsopterAreas(scenario.points), [scenario.points])

  return (
    <div data-scenario={scenario.id} className="space-y-4 border border-white/[0.06] rounded-2xl p-6 bg-surface/30">
      {/* Header — always rendered */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-heading font-bold">{scenario.label}</h2>
          <p className="text-zinc-400 text-sm mt-1">{scenario.description}</p>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-medium shrink-0 ${
          scenario.severity === 'Normal' ? 'bg-green-500/15 text-green-400' :
          scenario.severity === 'Mild' ? 'bg-yellow-500/15 text-yellow-400' :
          scenario.severity.startsWith('Moderate') ? 'bg-orange-500/15 text-orange-400' :
          scenario.severity === 'Severe' ? 'bg-red-500/15 text-red-400' :
          'bg-red-600/15 text-red-500'
        }`}>
          {scenario.severity}
        </span>
      </div>

      {/* Isopter areas — lightweight, always rendered */}
      <div className="grid grid-cols-5 gap-2">
        {ISOPTER_ORDER.map(key => {
          const area = areas[key]
          return (
            <div key={key} className="bg-surface rounded-xl p-2 text-center border border-white/[0.06]">
              <div className="flex items-center justify-center gap-1 mb-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STIMULI[key].color }} />
                <span className="text-xs text-zinc-400">{key}</span>
              </div>
              <span className="text-sm font-mono text-zinc-300">
                {area != null ? `${area.toFixed(0)}°²` : '—'}
              </span>
              {area != null && (
                <span className="block text-xs text-zinc-500">
                  ~{Math.sqrt(area / Math.PI).toFixed(1)}° r
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Heavy components — lazy rendered on scroll */}
      <LazySection>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <VisualFieldMap
                points={scenario.points}
                eye="right"
                maxEccentricity={scenario.maxEccentricity}
                size={mapSize}
              />
            </div>
            <div>
              <VisionSimulator
                points={scenario.points}
                eye="right"
                maxEccentricity={scenario.maxEccentricity}
              />
            </div>
          </div>

          <Interpretation points={scenario.points} areas={areas} maxEccentricityDeg={scenario.maxEccentricity} />

          <button
            onClick={(e) => {
              const card = (e.target as HTMLElement).closest('[data-scenario]')
              const canvas = card?.querySelector('canvas') as HTMLCanvasElement | null
              const visionSimImage = canvas?.toDataURL('image/png')

              const result: TestResult = {
                id: `demo-${scenario.id}`,
                eye: 'right',
                date: new Date().toISOString(),
                points: scenario.points,
                isopterAreas: areas,
                calibration: scenario.calibration,
                testType: 'goldmann',
              }
              exportResultPDF(result, {
                isDemo: true,
                visionSimImage,
              })
            }}
            className="w-full py-2.5 btn-primary rounded-xl text-sm font-medium text-white"
          >
            Export PDF
          </button>
        </div>
      </LazySection>
    </div>
  )
}

export function TestDemo({ onBack }: Props) {
  const scenarios = getAllScenarios()
  const mapSize = Math.min(380, typeof window !== 'undefined' ? window.innerWidth - 64 : 380)

  return (
    <main className="min-h-[100dvh] bg-base text-white safe-pad p-6 overflow-y-auto animate-page-in">
      <div className="max-w-4xl mx-auto space-y-12 pb-16">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-heading font-bold">Clinical Scenario Demo</h1>
            <p className="text-zinc-400 text-sm mt-1">
              Visual verification of radar maps, vision simulations, and interpretations
            </p>
          </div>
          <BackButton onClick={onBack} label="Home" />
        </div>

        {scenarios.map(scenario => (
          <ScenarioCard key={scenario.id} scenario={scenario} mapSize={mapSize} />
        ))}
      </div>
    </main>
  )
}
