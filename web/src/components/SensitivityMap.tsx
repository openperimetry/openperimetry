import { useEffect, useRef } from 'react'
import type { Eye } from '../types'
import {
  DB_MIN,
  DB_MAX,
  DB_MIN_DERIVED,
  DB_MAX_DERIVED,
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
  /** 'measured' = real staircase thresholds; 'derived' = pseudo-dB from
   *  Goldmann suprathreshold data. Drives the legend wording only. */
  source: 'measured' | 'derived'
  size?: number
  /** IDW power. 2 is SPECVIS-ish smoothness; 3 tightens around samples. */
  power?: number
}

function jetReverseColorCss(t: number): string {
  const { r, g, b } = jetReverseColor(t)
  return `rgb(${r},${g},${b})`
}

export function SensitivityMap({
  points,
  eye,
  maxEccentricity,
  source,
  size = 400,
  power = 2,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Derived-from-Goldmann data only spans {0, 10, -5-sentinel} dB, so we
  // use a tighter color ramp to keep the three outcomes visually distinct.
  const dbMin = source === 'measured' ? DB_MIN : DB_MIN_DERIVED
  const dbMax = source === 'measured' ? DB_MAX : DB_MAX_DERIVED

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    renderSensitivityToCanvas(ctx, points, size, maxEccentricity, power, dbMin, dbMax)
  }, [points, size, maxEccentricity, power, dbMin, dbMax])

  const midDb = Math.round((dbMin + dbMax) / 2)
  const label =
    source === 'measured'
      ? 'Measured sensitivity (dB)'
      : 'Derived sensitivity (dB, from Goldmann levels)'

  // Generate 7-stop legend gradient to faithfully match the jet_r colormap
  const legendStops = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]
    .map(t => `${jetReverseColorCss(t)} ${Math.round(t * 100)}%`)
    .join(', ')

  return (
    <div className="mx-auto" style={{ width: size }}>
      <div className="text-xs text-zinc-300 mb-1">
        {formatEyeLabelForResult(eye)} — {label}
      </div>
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className="rounded-full bg-zinc-900"
        style={{ width: size, height: size }}
      />
      <div className="flex items-center gap-2 mt-2 text-[10px] text-zinc-400">
        <span>{dbMin} dB (insensitive)</span>
        <div
          className="flex-1 h-2 rounded"
          style={{ background: `linear-gradient(to right, ${legendStops})` }}
        />
        <span>{dbMax} dB (sensitive)</span>
        <span className="ml-2">mid {midDb}</span>
      </div>
    </div>
  )
}
