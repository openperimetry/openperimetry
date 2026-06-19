/**
 * Horizontal "field score" continuum: the 0–100 field-preservation score
 * plotted across the base severity stages (Very severe → Normal). Severity and
 * pattern are orthogonal — this shows only the base stage; pattern modifiers
 * (ring scotoma, asymmetry) are rendered as separate tags by the caller.
 */
import { FIELD_SCORE_BANDS, fractionToScore, type FieldSeverity } from '../clinicalClassifications'

const STAGE_COLOR: Record<FieldSeverity, string> = {
  'very-severe': '#b91c1c', // red-700
  severe: '#dc2626',        // red-600
  moderate: '#ea580c',      // orange-600
  mild: '#d97706',          // amber-600
  borderline: '#65a30d',    // lime-600
  normal: '#16a34a',        // green-600
}

// 5 base-stage labels (borderline folds into the normal end of the scale).
const STAGE_LABEL: Partial<Record<FieldSeverity, string>> = {
  'very-severe': 'Very severe',
  severe: 'Severe',
  moderate: 'Moderate',
  mild: 'Early',
  normal: 'Normal',
}

interface Zone { severity: FieldSeverity; lo: number; hi: number }

// Ascending score zones derived from the band fractions, single source of truth.
function buildZones(): Zone[] {
  const zones: Zone[] = []
  let lo = 0
  for (const b of FIELD_SCORE_BANDS) {
    const hi = b.maxFraction === Infinity ? 100 : fractionToScore(b.maxFraction)
    zones.push({ severity: b.severity, lo, hi })
    lo = hi
  }
  return zones
}

interface Props {
  /** 0–100 field-preservation score. */
  score: number
  /** Headline stage label (e.g. "Moderate constriction"). */
  bandLabel: string
  severity: FieldSeverity
}

export function SeverityContinuum({ score, bandLabel, severity }: Props) {
  const zones = buildZones()
  const markerPct = Math.max(0, Math.min(100, score))
  const markerColor = STAGE_COLOR[severity]

  return (
    <div className="w-full">
      {/* Score + stage readout */}
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs text-muted">Field score</span>
        <span className="text-xs font-medium" style={{ color: markerColor }}>
          <span className="font-mono text-sm tnum">{score}</span>
          <span className="text-muted">/100 · </span>
          {bandLabel}
        </span>
      </div>

      {/* Continuum track: worst (left) → normal (right) */}
      <div className="relative pt-3 pb-0.5">
        {/* Marker */}
        <div
          className="absolute top-0 -translate-x-1/2 flex flex-col items-center"
          style={{ left: `${markerPct}%` }}
        >
          <span className="text-[10px] font-mono font-semibold tnum leading-none mb-0.5" style={{ color: markerColor }}>{score}</span>
        </div>
        <div className="flex h-2.5 rounded-full overflow-hidden">
          {zones.map(z => (
            <div
              key={z.severity}
              style={{ width: `${z.hi - z.lo}%`, backgroundColor: STAGE_COLOR[z.severity], opacity: 0.85 }}
              title={`${z.severity} (${z.lo}–${z.hi})`}
            />
          ))}
        </div>
        {/* Marker needle */}
        <div
          className="absolute -translate-x-1/2"
          style={{ left: `${markerPct}%`, top: 12 }}
        >
          <div className="w-0 h-0 mx-auto" style={{ borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: `6px solid ${markerColor}` }} />
        </div>
      </div>

      {/* Stage labels */}
      <div className="relative h-3 mt-0.5">
        {zones.filter(z => STAGE_LABEL[z.severity]).map(z => (
          <span
            key={z.severity}
            className="absolute -translate-x-1/2 text-[9px] text-muted whitespace-nowrap"
            style={{ left: `${(z.lo + z.hi) / 2}%` }}
          >
            {STAGE_LABEL[z.severity]}
          </span>
        ))}
      </div>
    </div>
  )
}
