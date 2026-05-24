import { useEffect, useRef } from 'react'
import type { Eye } from '../types'
import {
  DB_MIN,
  DB_MAX,
  jetReverseColor,
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
}

function jetReverseColorCss(t: number): string {
  const { r, g, b } = jetReverseColor(t)
  return `rgb(${r},${g},${b})`
}

export function SensitivityMap({
  points,
  eye,
  maxEccentricity,
  size = 400,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    renderSensitivityToCanvas(ctx, points, size, maxEccentricity)
  }, [points, size, maxEccentricity])

  const midDb = Math.round((DB_MIN + DB_MAX) / 2)

  // Generate 7-stop legend gradient to faithfully match the jet_r colormap
  const legendStops = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]
    .map(t => `${jetReverseColorCss(t)} ${Math.round(t * 100)}%`)
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
      <div className="text-xs text-zinc-300 mb-1">
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
      <div className="flex items-center gap-2 mt-2 text-[10px] text-zinc-400">
        <span>{DB_MIN} dB (insensitive)</span>
        <div
          className="flex-1 h-2 rounded"
          style={{ background: `linear-gradient(to right, ${legendStops})` }}
        />
        <span>{DB_MAX} dB (sensitive)</span>
        <span className="ml-2">mid {midDb}</span>
      </div>
    </div>
  )
}
