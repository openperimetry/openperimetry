import { useState } from 'react'
import type { TestPoint, Eye, StimulusKey, CalibrationData } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { polarToXY, smoothClosedPath, computeIsopters, computeScreenBoundary } from '../isopterRender'
import { formatEyeLabelForResult } from '../eyeLabels'
import { VerifyOverlay } from './VerifyOverlay'

interface Props {
  points: TestPoint[]
  eye: Eye
  maxEccentricity: number
  /** Plotted extent (rings + scale) in degrees. Defaults to `maxEccentricity`.
   *  Phone-VR passes a smaller, data-fitted value so the radar isn't a tiny
   *  isopter inside a wide untested halo (the screen-edge maxEccentricity ~44°
   *  far exceeds the realistic VR-tested field). Render-only — does not affect
   *  isopter geometry, areas, or classification. */
  plotExtentDeg?: number
  size?: number
  showLabels?: boolean
  /** If provided, draws the screen-testable boundary on the radar */
  calibration?: CalibrationData
  /** Show a corner button that opens the 1:1 verify overlay. Requires calibration. */
  enableVerify?: boolean
  /** Test-retest aggregation across repeated sessions. When present, each
   *  aggregated point is rendered as a disk whose color encodes per-point
   *  standard deviation (green → yellow → red) and whose opacity encodes
   *  mean detection rate. Key format: "meridianDeg,eccentricityDeg". */
  variance?: Map<string, { mean: number; stdev: number; n: number }>
}

/** Map per-point SD (0 → 0.5 for binary detection) to a diagnostic color.
 *  Stable, low-noise points are green; unreliable ones are red. */
function sdToColor(stdev: number): string {
  const t = Math.min(1, Math.max(0, stdev / 0.5))
  // Green (#10b981) → Yellow (#eab308) → Red (#ef4444)
  if (t < 0.5) {
    // green → yellow
    const k = t / 0.5
    const r = Math.round(0x10 + (0xea - 0x10) * k)
    const g = Math.round(0xb9 + (0xb3 - 0xb9) * k)
    const b = Math.round(0x81 + (0x08 - 0x81) * k)
    return `rgb(${r},${g},${b})`
  }
  // yellow → red
  const k = (t - 0.5) / 0.5
  const r = Math.round(0xea + (0xef - 0xea) * k)
  const g = Math.round(0xb3 + (0x44 - 0xb3) * k)
  const b = Math.round(0x08 + (0x44 - 0x08) * k)
  return `rgb(${r},${g},${b})`
}

const CHART_PADDING = 40

// Boundary binning + smoothing live in ../isopterCalc.ts; pixel-space
// isopter rendering (polar projection, Catmull-Rom path, per-level
// clamp) lives in ../isopterRender.ts so VerifyOverlay and the PDF
// export share the exact same contour generation as this component.

export function VisualFieldMap({
  points,
  eye,
  maxEccentricity,
  plotExtentDeg,
  size = 400,
  showLabels = true,
  calibration,
  enableVerify = false,
  variance,
}: Props) {
  const [verifyOpen, setVerifyOpen] = useState(false)
  const center = size / 2
  const radius = center - CHART_PADDING
  // Plotted extent: caller-supplied (VR fits it to the data) or the full
  // testable maxEccentricity. Guard against a degenerate <=0 value.
  const effectiveMaxEcc = plotExtentDeg && plotExtentDeg > 0 ? plotExtentDeg : maxEccentricity
  const scale = radius / effectiveMaxEcc
  const ringStep = effectiveMaxEcc <= 30 ? 5 : 10
  const rings = Array.from(
    { length: Math.floor(effectiveMaxEcc / ringStep) },
    (_, i) => (i + 1) * ringStep,
  )
  const meridians = Array.from({ length: 12 }, (_, i) => i * 30)

  // Group points by stimulus
  const grouped: Partial<Record<StimulusKey, TestPoint[]>> = {}
  for (const p of points) {
    if (!grouped[p.stimulus]) grouped[p.stimulus] = []
    grouped[p.stimulus]!.push(p)
  }

  // Blind spot
  const bsMeridian = eye === 'right' ? 0 : 180
  const [bsX, bsY] = polarToXY(15, bsMeridian - 2, center, scale)

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        className="bg-gray-900 rounded-xl"
      >
        {/* Concentric rings */}
        {rings.map(deg => (
          <circle
            key={deg}
            cx={center}
            cy={center}
            r={deg * scale}
            fill="none"
            stroke="#334155"
            strokeWidth={0.5}
          />
        ))}

        {/* Ring labels */}
        {showLabels &&
          rings
            .filter((_, i) => i % 2 === 1 || rings.length <= 6)
            .map(deg => (
              <text key={`lbl-${deg}`} x={center + deg * scale + 2} y={center - 3} fill="#64748b" fontSize={9}>
                {deg}°
              </text>
            ))}

        {/* Meridian lines */}
        {meridians.map(deg => {
          const [x, y] = polarToXY(effectiveMaxEcc, deg, center, scale)
          return (
            <line key={`m-${deg}`} x1={center} y1={center} x2={x} y2={y} stroke="#334155" strokeWidth={0.5} />
          )
        })}

        {/* Axis labels */}
        {showLabels && (
          <>
            <text x={size - CHART_PADDING + 4} y={center + 4} fill="#94a3b8" fontSize={11}>
              {eye === 'right' ? 'T' : 'N'}
            </text>
            <text x={4} y={center + 4} fill="#94a3b8" fontSize={11}>
              {eye === 'right' ? 'N' : 'T'}
            </text>
            <text x={center - 3} y={CHART_PADDING - 6} fill="#94a3b8" fontSize={11}>S</text>
            <text x={center - 3} y={size - CHART_PADDING + 14} fill="#94a3b8" fontSize={11}>I</text>
          </>
        )}

        {/* Screen boundary + "not tested" shading beyond it. Shared with
            the PDF export via `computeScreenBoundary` so both surfaces
            paint the same mask. Follows the HFA printout convention of
            visually distinguishing untested territory from tested
            zero-sensitivity regions. */}
        {calibration && (() => {
          const boundary = computeScreenBoundary(calibration, center, scale, radius, {
            width: typeof window !== 'undefined' ? window.innerWidth : 1600,
            height: typeof window !== 'undefined' ? window.innerHeight : 900,
          })
          if (!boundary) return null
          return (
            <g>
              <path
                d={boundary.maskPath}
                fill="#475569"
                fillOpacity={0.22}
                fillRule="evenodd"
                pointerEvents="none"
              />
              <polygon
                points={boundary.polygonStr}
                fill="none"
                stroke="#3b82f6"
                strokeWidth={1}
                strokeOpacity={0.45}
                strokeDasharray="4,3"
              />
              <text
                x={center}
                y={CHART_PADDING - 22}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize={8}
                opacity={0.7}
              >
                not tested (beyond screen)
              </text>
            </g>
          )
        })()}

        {/* Blind spot */}
        <ellipse
          cx={bsX} cy={bsY}
          rx={3.5 * scale} ry={2.5 * scale}
          fill="#1e293b" stroke="#475569" strokeWidth={0.5} strokeDasharray="2,2"
        />

        {/* Render isopters from outermost to innermost */}
        {computeIsopters(grouped, center, scale).map(({ key, isopterIdx, svgPts, isScattered }) => {
          const color = STIMULI[key].color
          const path = smoothClosedPath(svgPts)

          const dashPatterns: (string | undefined)[] = [undefined, undefined, '6,3', '3,3', '1,3']
          const strokeWidths = [2, 1.8, 1.5, 1.5, 1.3]
          const fillOpacities = [0.10, 0.08, 0.06, 0.05, 0.04]

          const topIdx = svgPts.reduce((best, pt, i) => (pt[1] < svgPts[best][1] ? i : best), 0)
          const labelPt = svgPts[topIdx]

          return (
            <g key={key}>
              <path d={path} fill={color} fillOpacity={fillOpacities[isopterIdx]} stroke="none" />
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeWidth={strokeWidths[isopterIdx]}
                strokeDasharray={dashPatterns[isopterIdx]}
              />
              {!isScattered && svgPts.map((pt, i) => (
                <circle key={i} cx={pt[0]} cy={pt[1]} r={2.5} fill={color} />
              ))}
              {showLabels && labelPt && (
                <text
                  x={labelPt[0] + 4}
                  y={labelPt[1] - 5}
                  fill={color}
                  fontSize={8}
                  fontWeight="bold"
                  opacity={0.8}
                >
                  {STIMULI[key].label}
                </text>
              )}
            </g>
          )
        })}

        {/* Undetected points — colored by stimulus level so you can tell
            which isopter the missed point belongs to. Outlined hollow ring
            distinguishes them from detected boundary nodes. */}
        {points
          .filter(p => !p.detected)
          .map((p, i) => {
            const [x, y] = polarToXY(p.eccentricityDeg, p.meridianDeg, center, scale)
            const color = STIMULI[p.stimulus]?.color ?? '#ef4444'
            return (
              <circle
                key={`nd-${i}`}
                cx={x}
                cy={y}
                r={2}
                fill="none"
                stroke={color}
                strokeWidth={1}
                opacity={0.7}
              />
            )
          })}

        {/* Variance overlay — one disk per aggregated grid point, color
            encodes per-point SD across sessions, opacity encodes mean
            detection rate. Rendered above isopters so variance is visible
            on any stored pattern. */}
        {variance && Array.from(variance.entries()).map(([key, agg]) => {
          const [mStr, eStr] = key.split(',')
          const meridianDeg = Number(mStr)
          const eccDeg = Number(eStr)
          if (!Number.isFinite(meridianDeg) || !Number.isFinite(eccDeg)) return null
          const [x, y] = polarToXY(eccDeg, meridianDeg, center, scale)
          const color = sdToColor(agg.stdev)
          // Clamp opacity so low-mean (often-missed) points are still visible.
          const opacity = 0.3 + 0.7 * agg.mean
          return (
            <circle
              key={`var-${key}`}
              cx={x}
              cy={y}
              r={4}
              fill={color}
              opacity={opacity}
              stroke="#0b0b12"
              strokeWidth={0.5}
            >
              <title>
                {`${meridianDeg}°, ${eccDeg}°\nmean ${(agg.mean * 100).toFixed(0)}%, SD ${agg.stdev.toFixed(2)}, n=${agg.n}`}
              </title>
            </circle>
          )
        })}

        {/* Fixation dot */}
        <circle cx={center} cy={center} r={2} fill="#fbbf24" />
      </svg>
      </div>

      {/* Legend */}
      {showLabels && (
        <div className="text-xs text-body flex gap-3 flex-wrap justify-center">
          <span className="text-muted">{formatEyeLabelForResult(eye)}</span>
          {ISOPTER_ORDER.map(key => {
            if (!grouped[key]?.some(p => p.detected)) return null
            return (
              <span key={key} className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: STIMULI[key].color }} />
                {STIMULI[key].label}
              </span>
            )
          })}
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full border border-gray-400" /> missed
          </span>
          {calibration && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-0 border-t border-dashed border-blue-500 opacity-40" /> screen limit
            </span>
          )}
        </div>
      )}

      {/* Prominent 1:1 verify control — sits directly under the legend, styled
          like the "Compare with clinical scenarios" button, so the at-true-scale
          check is discoverable rather than hidden behind a small map-corner icon. */}
      {enableVerify && calibration && (
        <button
          onClick={() => setVerifyOpen(true)}
          className="w-full py-3 bg-surface hover:bg-subtle rounded-xl font-medium transition-colors border border-line hover:border-accent/50 text-sm text-body"
        >
          <svg className="inline w-4 h-4 mr-1.5 -mt-0.5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
          Verify at 1:1 scale
        </button>
      )}

      {verifyOpen && calibration && (
        <VerifyOverlay points={points} eye={eye} calibration={calibration} onClose={() => setVerifyOpen(false)} />
      )}
    </div>
  )
}
