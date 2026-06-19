import { useEffect, useRef } from 'react'
import type { Eye } from '../types'
import {
  DB_MIN,
  DB_MAX,
  sensitivityGreyForT,
  renderSensitivityToCanvas,
} from '../sensitivity'
import { formatEyeLabelForResult } from '../eyeLabels'

interface DbPoint {
  meridianDeg: number
  eccentricityDeg: number
  db: number
}

interface Props {
  points: DbPoint[]
  eye: Eye
  maxEccentricity: number
  size?: number
  /** Optional upper bound for the dB colormap. When the run is
   *  calibration-limited (the brightness-floor calibration step
   *  caps the staircase ceiling), passing the effective ceiling
   *  here normalises the greyscale across the *measurable* range
   *  instead of -5 → 40 dB — so spatial variation within the
   *  range you could actually measure becomes visible instead of
   *  bunching at the dark end. Omit for the absolute-scale view
   *  (default behaviour, matches legacy callers + PDF export). */
  dbCeiling?: number
}

function sensitivityGreyCss(t: number): string {
  const { r, g, b } = sensitivityGreyForT(t)
  return `rgb(${r},${g},${b})`
}

export function SensitivityMap({
  points,
  eye,
  maxEccentricity,
  size = 400,
  dbCeiling,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Clamp the ceiling on the consumer side too, so the legend and
  // the canvas see identical effective bounds. Rounded to an
  // integer because the unrounded value is a 16-digit float
  // (`-10 · log10(0.075) = 11.249387366082999`), and showing that
  // as a legend label is just noise. Sub-dB precision in the
  // colormap doesn't buy visible accuracy.
  const effectiveCeiling = dbCeiling != null
    ? Math.min(DB_MAX, Math.max(DB_MIN + 1, Math.round(dbCeiling)))
    : DB_MAX

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    renderSensitivityToCanvas(ctx, points, size, maxEccentricity, effectiveCeiling)
  }, [points, size, maxEccentricity, effectiveCeiling])

  // Mean of the test's measured dB values. Used to render a tick
  // marker on the legend bar at the user's average sensitivity —
  // single point of reference for "where does this run sit within
  // the measurable range". `meanPct` is the tick's left-offset
  // within the bar, clamped to [0, 100] in case the mean lands
  // slightly outside the colormap bounds (would happen for the
  // unseen-sentinel value DB_MIN if it dominated the sample).
  const measuredDbs = points.map(p => p.db).filter(Number.isFinite)
  const meanDb = measuredDbs.length > 0
    ? measuredDbs.reduce((a, b) => a + b, 0) / measuredDbs.length
    : null
  const meanPct = meanDb != null
    ? Math.max(0, Math.min(100, ((meanDb - DB_MIN) / (effectiveCeiling - DB_MIN)) * 100))
    : null

  // 7-stop greyscale gradient matching the heatmap renderer's
  // `sensitivityGreyForT` (dark = defect, light = healthy sensitivity).
  // Mirrors the HFA greyscale plot convention so a clinician (or a user
  // comparing to their own clinical printout) reads the legend the same
  // way they'd read a Single Field Analysis page.
  const legendStops = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]
    .map(t => `${sensitivityGreyCss(t)} ${Math.round(t * 100)}%`)
    .join(', ')

  // CHART_PADDING must match the value the renderer uses so rings/labels
  // line up with the painted heatmap.
  const CHART_PADDING = 40
  const center = size / 2
  const radius = center - CHART_PADDING

  // Ring steps — coarser when maxEccentricity is large (30-2 at 30°) so the
  // plot isn't cluttered. Matches the Goldmann radar convention.
  const ringStep = maxEccentricity <= 15 ? 3 : maxEccentricity <= 30 ? 10 : 10
  const rings: number[] = []
  for (let r = ringStep; r <= maxEccentricity + 0.5; r += ringStep) rings.push(r)

  const temporalLabel = eye === 'right' ? 'T' : 'N'
  const nasalLabel = eye === 'right' ? 'N' : 'T'

  return (
    <div className="mx-auto" style={{ width: size }}>
      <div className="text-xs text-body mb-1">
        {formatEyeLabelForResult(eye)} — Measured sensitivity (dB)
      </div>
      <div className="relative" style={{ width: size, height: size }}>
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          className="rounded-full bg-zinc-900 absolute inset-0"
          style={{ width: size, height: size }}
        />
        {/* Degree rings + N/T/S/I axes as SVG overlay so the canvas can
            stay focused on the jet_r heatmap. Rings are stroked with a
            low-alpha white so they're legible over both warm and cool
            regions of the colormap. */}
        <svg
          className="absolute inset-0 pointer-events-none"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
        >
          {rings.map(r => {
            const px = (r / maxEccentricity) * radius
            return (
              <g key={r}>
                {/* Dark halo ring + lighter inner ring give the concentric
                    guides contrast over both warm and cool areas of the
                    jet_r colormap. */}
                <circle
                  cx={center}
                  cy={center}
                  r={px}
                  fill="none"
                  stroke="#000000"
                  strokeOpacity={0.35}
                  strokeWidth={1.75}
                  strokeDasharray="2,3"
                />
                <circle
                  cx={center}
                  cy={center}
                  r={px}
                  fill="none"
                  stroke="#ffffff"
                  strokeOpacity={0.55}
                  strokeWidth={0.75}
                  strokeDasharray="2,3"
                />
              </g>
            )
          })}
          {/* Text labels use paint-order="stroke" so the dark outline sits
              behind the white fill — legible over any heatmap color. */}
          {rings.map(r => {
            const px = (r / maxEccentricity) * radius
            return (
              <text
                key={`label-${r}`}
                x={center + px + 3}
                y={center - 3}
                fill="#ffffff"
                stroke="#000000"
                strokeWidth={3}
                strokeOpacity={0.75}
                paintOrder="stroke"
                fontSize={9}
                fontFamily="sans-serif"
              >
                {r}°
              </text>
            )
          })}
          {[
            { label: temporalLabel, x: size - CHART_PADDING + 4, y: center + 4 },
            { label: nasalLabel, x: 4, y: center + 4 },
            { label: 'S', x: center - 3, y: CHART_PADDING - 6 },
            { label: 'I', x: center - 3, y: size - CHART_PADDING + 14 },
          ].map(({ label, x, y }) => (
            <text
              key={label + x + y}
              x={x}
              y={y}
              fill="#ffffff"
              stroke="#000000"
              strokeWidth={3}
              strokeOpacity={0.75}
              paintOrder="stroke"
              fontSize={11}
              fontFamily="sans-serif"
            >
              {label}
            </text>
          ))}
        </svg>
      </div>
      <div className="mt-2 text-[10px] text-muted">
        <div className="flex items-center gap-2">
          <span>{DB_MIN} dB (insensitive)</span>
          {/* Bar wrapped in `relative` so the mean-dB tick can be
              absolute-positioned over it. Tick is a thin gold
              vertical line that extends slightly above and below
              the bar so it's visible against both ends of the
              greyscale; aria-hidden because the dB value is
              already in the label row below. */}
          <div className="flex-1 relative">
            <div
              className="h-2 rounded"
              style={{ background: `linear-gradient(to right, ${legendStops})` }}
            />
            {meanPct !== null && (
              <div
                aria-hidden="true"
                className="absolute w-[2px] bg-accent rounded-full shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                style={{ top: -3, bottom: -3, left: `${meanPct}%`, transform: 'translateX(-50%)' }}
              />
            )}
          </div>
          {/* Right-end label = effective ceiling. The "(sensitive)"
              tag stays only when the bar represents the full
              clinical range; on a capped bar the ceiling isn't
              clinically sensitive territory, so we drop the
              parenthetical to avoid mis-implying it is. */}
          <span>{effectiveCeiling} dB{effectiveCeiling === DB_MAX ? ' (sensitive)' : ''}</span>
        </div>
        {meanDb !== null && (
          <p className="mt-1 text-center text-muted">
            <span className="text-accent">▌</span>{' '}mean {meanDb.toFixed(1)} dB
          </p>
        )}
      </div>
    </div>
  )
}
