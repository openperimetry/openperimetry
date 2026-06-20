/**
 * Clinical scenario picker. Each card links to that scenario's result page
 * (the genuine Goldmann results screen) at #demos/<id>. Field-map previews
 * are lazy-rendered on scroll for performance.
 */
import { useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { getAllScenarios } from '../testFixtures'
import { BackButton } from './AccessibleNav'
import { VisualFieldMap } from './VisualFieldMap'
import { severityBadgeClass } from '../severityBadge'

interface Props {
  onBack: () => void
  onSelectScenario: (id: string) => void
}

/** Renders children only once the element scrolls near the viewport. */
function LazyPreview({ children, minHeight = 200 }: { children: ReactNode; minHeight?: number }) {
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
    <div ref={ref} className="flex justify-center">
      {visible ? children : <div style={{ minHeight }} className="w-full flex items-center justify-center text-muted text-xs">Scroll to load…</div>}
    </div>
  )
}

export function TestDemo({ onBack, onSelectScenario }: Props) {
  const scenarios = getAllScenarios()
  const previewSize = 200

  return (
    <main className="min-h-[100dvh] bg-base text-body safe-pad p-6 overflow-y-auto animate-page-in">
      <div className="max-w-4xl mx-auto space-y-6 pb-16">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-heading font-bold">Clinical Scenario Demo</h1>
            <p className="text-muted text-sm mt-1">Select a scenario to open a sample result.</p>
          </div>
          <BackButton onClick={onBack} label="Home" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {scenarios.map(scenario => (
            <button
              key={scenario.id}
              data-scenario={scenario.id}
              onClick={() => onSelectScenario(scenario.id)}
              className="text-left flex flex-col gap-3 border border-line rounded-2xl p-4 bg-surface hover:border-accent transition-colors focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-base font-heading font-bold">{scenario.label}</h2>
                <span className={severityBadgeClass(scenario.severity)}>{scenario.severity}</span>
              </div>
              <LazyPreview minHeight={previewSize}>
                <VisualFieldMap
                  points={scenario.points}
                  eye="right"
                  maxEccentricity={scenario.maxEccentricity}
                  size={previewSize}
                  showLabels={false}
                />
              </LazyPreview>
              <p className="text-muted text-xs leading-relaxed">{scenario.description}</p>
            </button>
          ))}
        </div>
      </div>
    </main>
  )
}
