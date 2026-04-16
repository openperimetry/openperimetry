// HeadGuide — side-view illustration: head in profile facing a vertical
// screen with a distance callout. Shared by Goldmann, Ring, and Static
// test instruction panels so all three show a consistent "how to sit"
// guide during calibration / pre-test.

import type { StoredEye } from '../types'

interface Props {
  eye: StoredEye
  viewingDistanceCm: number
  compact?: boolean
}

export function HeadGuide({ eye, viewingDistanceCm, compact = false }: Props) {
  const h = compact ? 140 : 180
  const w = 280
  const coveredEye = eye === 'right' ? 'left' : 'right'
  const screenX = w - 48
  const eyeY = 42

  return (
    <div className="flex flex-col items-center gap-2">
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="opacity-70">
        <defs>
          <marker id="arrowL" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 10 0 L 0 5 L 10 10 z" fill="#64748b" />
          </marker>
          <marker id="arrowR" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
          </marker>
        </defs>
        {/* Head profile (facing right) */}
        <circle cx={70} cy={45} r={24} fill="none" stroke="#64748b" strokeWidth={1.5} />
        {/* Nose */}
        <path d="M 92 45 L 99 50 L 92 55" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinejoin="round" />
        {/* Sight line from active eye to screen */}
        <line
          x1={88} y1={eyeY}
          x2={screenX - 2} y2={eyeY}
          stroke="#fbbf24" strokeWidth={1} strokeDasharray="3,3" opacity={0.7}
        />
        {/* Neck */}
        <path d="M 60 67 Q 68 78 76 86" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
        {/* Spine — leaning forward onto the desk */}
        <path d="M 76 86 Q 110 108 150 150" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
        {/* Shoulder */}
        <path d="M 76 86 Q 80 94 84 102" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
        {/* Upper arm — shoulder forward-down to elbow resting on desk */}
        <line x1={84} y1={102} x2={118} y2={150} stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
        {/* Forearm — elbow angled back up to hand over the eye */}
        <line x1={118} y1={150} x2={84} y2={46} stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
        {/* Hand — covering the near-side eye */}
        <ellipse cx={86} cy={42} rx={7} ry={5} fill="#475569" stroke="#94a3b8" strokeWidth={1.2} />
        {/* Desk surface */}
        <line x1={28} y1={154} x2={215} y2={154} stroke="#475569" strokeWidth={1.5} strokeLinecap="round" />
        {/* Desk edge hint */}
        <line x1={215} y1={154} x2={215} y2={168} stroke="#475569" strokeWidth={1} strokeLinecap="round" />
        {/* Screen — vertical bar */}
        <rect x={screenX} y={10} width={6} height={72} rx={1} fill="#334155" />
        <text x={screenX + 3} y={6} fill="#64748b" fontSize={9} textAnchor="middle">screen</text>
        {/* Fixation dot on screen */}
        <circle cx={screenX + 3} cy={eyeY} r={3} fill="#fbbf24" />
        {/* Distance callout */}
        <line
          x1={102} y1={eyeY + 22}
          x2={screenX} y2={eyeY + 22}
          stroke="#64748b" strokeWidth={1}
          markerStart="url(#arrowL)" markerEnd="url(#arrowR)"
        />
        <text
          x={(102 + screenX) / 2} y={eyeY + 18}
          fill="#94a3b8" fontSize={11} textAnchor="middle" fontWeight={600}
        >
          {viewingDistanceCm} cm
        </text>
      </svg>
      {!compact && (
        <p className="text-xs text-gray-500 text-center">
          Sit {viewingDistanceCm} cm from the screen.
          Cover your {coveredEye} eye and look straight at the yellow dot.
        </p>
      )}
    </div>
  )
}
