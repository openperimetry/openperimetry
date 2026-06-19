/**
 * Pre-test preview of the configured stimulus-distribution grid. Shows
 * every point the user will be asked to fixate a response for, overlaid
 * on concentric eccentricity rings, so the clinician can see the
 * density and coverage at a glance before starting.
 *
 * Used inside the Advanced Settings panel (live updates as the user
 * tweaks spacing/extent) and intentionally distinct from
 * `SensitivityMap`, which renders measured results after a test run.
 *
 * Rendered as SVG so it stays crisp at any size and avoids the
 * canvas-resize dance the measured-sensitivity map does. For typical
 * grids (40–140 points) the DOM node count is negligible.
 */

import type { GridPoint } from '../grids'

interface Props {
  /** Grid points to plot (in right-eye convention; caller passes the
   *  already-eye-adjusted output of `getStaticGrid` / `generateCustomGrid`). */
  points: GridPoint[]
  /** Half-width of the plot in degrees. Usually matches
   *  `Math.max(extentXDeg, extentYDeg)` plus a few degrees of padding
   *  so the outermost stimuli aren't flush to the rim. Defaults to 30. */
  maxEccentricityDeg?: number
  /** Pixel size (width = height) of the rendered SVG. */
  size?: number
  /** Optional labelled caption shown above the plot, e.g. "Right eye · 100 points". */
  caption?: string
}

/** Ring radii (°) to draw as concentric reference circles. The list is
 *  filtered at render time to whatever fits inside `maxEccentricityDeg`. */
const RING_ECCENTRICITIES_DEG = [10, 20, 30, 40, 50]

export function SensitivityFieldPreview({
  points,
  maxEccentricityDeg = 30,
  size = 240,
  caption,
}: Props) {
  const half = size / 2
  // Scale: 1° of visual angle = (half / maxEccentricity) pixels. Points
  // are drawn relative to (half, half) which is fixation.
  const scale = half / maxEccentricityDeg

  const rings = RING_ECCENTRICITIES_DEG.filter(e => e <= maxEccentricityDeg)

  return (
    <div className="inline-block">
      {caption && <div className="text-[11px] text-muted mb-1">{caption}</div>}
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={caption ?? `Stimulus grid preview: ${points.length} points`}
        className="rounded-full bg-zinc-900 border border-white/[0.06]"
      >
        {/* Eccentricity reference rings */}
        {rings.map(deg => (
          <circle
            key={deg}
            cx={half}
            cy={half}
            r={deg * scale}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={0.5}
          />
        ))}
        {/* Cardinal meridian crosshairs */}
        <line
          x1={0}
          y1={half}
          x2={size}
          y2={half}
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={0.5}
        />
        <line
          x1={half}
          y1={0}
          x2={half}
          y2={size}
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={0.5}
        />
        {/* Fixation cross */}
        <line
          x1={half - 4}
          y1={half}
          x2={half + 4}
          y2={half}
          stroke="#f59e0b"
          strokeWidth={1}
        />
        <line
          x1={half}
          y1={half - 4}
          x2={half}
          y2={half + 4}
          stroke="#f59e0b"
          strokeWidth={1}
        />
        {/* Stimulus points. We flip y (visual-field +y = superior) so
            the preview matches how a clinician reads a field map. */}
        {points.map(p => (
          <circle
            key={p.key}
            cx={half + p.xDeg * scale}
            cy={half - p.yDeg * scale}
            r={2}
            fill="rgba(251, 191, 36, 0.85)"
          />
        ))}
      </svg>
    </div>
  )
}
