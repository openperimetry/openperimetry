/**
 * Sparkline of the 0–100 field-preservation score across a single eye's
 * sessions over time. Higher = more field preserved, so a downward trend is
 * worsening. The currently-viewed session is highlighted.
 */
export interface TrendPoint {
  id: string
  date: string
  score: number
}

interface Props {
  history: TrendPoint[]
  currentId?: string
}

export function ScoreTrend({ history, currentId }: Props) {
  const n = history.length
  if (n < 2) return null

  const w = 280
  const h = 48
  const pad = 6
  const xs = (i: number) => pad + (i / (n - 1)) * (w - 2 * pad)
  const ys = (s: number) => h - pad - (s / 100) * (h - 2 * pad)
  const path = history
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xs(i).toFixed(1)} ${ys(p.score).toFixed(1)}`)
    .join(' ')

  const latest = history[n - 1]
  const prev = history[n - 2]
  const delta = latest.score - prev.score

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" aria-hidden="true">
        {/* 50/100 reference line */}
        <line x1={pad} y1={ys(50)} x2={w - pad} y2={ys(50)} stroke="var(--color-line)" strokeWidth={0.5} strokeDasharray="2,2" />
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} />
        {history.map((p, i) => (
          <g key={p.id}>
            <circle
              cx={xs(i)}
              cy={ys(p.score)}
              r={p.id === currentId ? 3.5 : 2}
              fill={p.id === currentId ? 'var(--color-accent)' : 'var(--color-surface)'}
              stroke="var(--color-accent)"
              strokeWidth={1.5}
            />
            {/* Larger transparent hit area so the score tooltip is easy to hover. */}
            <circle cx={xs(i)} cy={ys(p.score)} r={10} fill="transparent" style={{ cursor: 'pointer' }}>
              <title>{`Field score ${p.score}/100 · ${new Date(p.date).toLocaleDateString()}`}</title>
            </circle>
          </g>
        ))}
      </svg>
      <div className="flex items-center justify-between text-xs mt-1">
        <span className="text-muted">
          Latest <span className="font-mono tnum text-ink">{latest.score}</span>/100
        </span>
        <span className={delta >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
          {delta >= 0 ? '+' : ''}{delta} vs previous
        </span>
      </div>
    </div>
  )
}
