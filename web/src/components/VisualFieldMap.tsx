import { useState } from 'react'
import type { TestPoint, Eye, StimulusKey, CalibrationData } from '../types'
import { STIMULI, ISOPTER_ORDER } from '../types'
import { polarToXY, smoothClosedPath, computeIsopters } from '../isopterRender'
import { formatEyeLabelForResult } from '../eyeLabels'
import { VerifyOverlay } from './VerifyOverlay'

interface Props {
  points: TestPoint[]
  eye: Eye
  maxEccentricity: number
  size?: number
  showLabels?: boolean
  /** If provided, draws the screen-testable boundary on the radar */
  calibration?: CalibrationData
  /** Show a corner button that opens the 1:1 verify overlay. Requires calibration. */
  enableVerify?: boolean
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
  size = 400,
  showLabels = true,
  calibration,
  enableVerify = false,
}: Props) {
  const [verifyOpen, setVerifyOpen] = useState(false)
  const center = size / 2
  const radius = center - CHART_PADDING
  const scale = radius / maxEccentricity
  const ringStep = maxEccentricity <= 30 ? 5 : 10
  const rings = Array.from(
    { length: Math.floor(maxEccentricity / ringStep) },
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
      {enableVerify && calibration && (
        <button
          onClick={() => setVerifyOpen(true)}
          aria-label="Open 1:1 verify view"
          title="Verify at 1:1 scale"
          className="absolute top-2 right-2 z-10 w-8 h-8 rounded-lg bg-black/50 hover:bg-black/70 border border-white/[0.10] text-zinc-300 hover:text-white flex items-center justify-center transition-colors"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
      )}
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
          const [x, y] = polarToXY(maxEccentricity, deg, center, scale)
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

        {/* Screen boundary — shows the limits of what was testable */}
        {calibration && (() => {
          const pxPerDeg = calibration.pixelsPerDegree
          const fx = calibration.fixationOffsetPx
          // Use stored screen dimensions from calibration time, fall back to current window
          const screenW = calibration.screenWidthPx ?? (typeof window !== 'undefined' ? window.innerWidth : 1600)
          const screenH = calibration.screenHeightPx ?? (typeof window !== 'undefined' ? window.innerHeight : 900)
          const halfW = screenW / 2
          const halfH = screenH / 2
          const pts = Array.from({ length: 72 }, (_, i) => {
            const angleDeg = i * 5
            const rad = (angleDeg * Math.PI) / 180
            const cos = Math.cos(rad)
            const sin = -Math.sin(rad)
            let t = 9999
            if (cos > 0.001) t = Math.min(t, (halfW - fx) / cos)
            if (cos < -0.001) t = Math.min(t, (-halfW - fx) / cos)
            if (sin > 0.001) t = Math.min(t, halfH / sin)
            if (sin < -0.001) t = Math.min(t, (-halfH) / sin)
            const eccDeg = t / pxPerDeg
            const r = Math.min(eccDeg * scale, radius + 5)
            return `${center + r * Math.cos(rad)},${center + r * sin}`
          })
          return (
            <polygon
              points={pts.join(' ')}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={1}
              strokeOpacity={0.3}
              strokeDasharray="4,3"
            />
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

        {/* Fixation dot */}
        <circle cx={center} cy={center} r={2} fill="#fbbf24" />
      </svg>
      </div>

      {/* Legend */}
      {showLabels && (
        <div className="text-xs text-gray-400 flex gap-3 flex-wrap justify-center">
          <span className="text-gray-500">{formatEyeLabelForResult(eye)}</span>
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

      {verifyOpen && calibration && (
        <VerifyOverlay points={points} eye={eye} calibration={calibration} onClose={() => setVerifyOpen(false)} />
      )}
    </div>
  )
}
