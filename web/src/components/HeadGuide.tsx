// HeadGuide — side-view illustration: head in profile facing a vertical
// screen with a distance callout. Shared by Goldmann, Ring, and Static
// test instruction panels so all three show a consistent "how to sit"
// guide during calibration / pre-test.
//
// Two posture variants:
//  - "desktop" (default): seated at a desk, near-side hand covering the
//    untested eye, looking at a vertical monitor.
//  - "phone": seated at a desk with both elbows on the desk and both
//    hands raised holding a phone in front of the face. The phone is
//    closer than the monitor would be (typical viewing distance 20 cm),
//    so the callout shrinks to match.

import type { StoredEye } from '../types'

interface Props {
  eye: StoredEye
  viewingDistanceCm: number
  compact?: boolean
  /** Posture variant. Defaults to 'desktop' so existing callers are unchanged. */
  mode?: 'desktop' | 'phone'
}

export function HeadGuide({ eye, viewingDistanceCm, compact = false, mode = 'desktop' }: Props) {
  const h = compact ? 140 : 180
  const w = 280
  const coveredEye = eye === 'right' ? 'left' : 'right'

  if (mode === 'phone') {
    // Phone mode geometry — all elements stay within y ∈ [0, 130] so the
    // compact (h=140) variant doesn't crop the elbows. The desktop variant
    // gets the same content with extra blank space at the bottom of the
    // canvas, mirroring how the original head/screen illustration handles
    // compact vs full.
    const eyeY = 38
    const phoneX = 140
    const phoneTopY = 14
    const phoneBottomY = 70
    const deskY = 116
    return (
      <div className="flex flex-col items-center gap-2">
        <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="opacity-70">
          <defs>
            <marker id="phArrowL" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 10 0 L 0 5 L 10 10 z" fill="#64748b" />
            </marker>
            <marker id="phArrowR" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
            </marker>
          </defs>
          {/* Head profile (facing right) */}
          <circle cx={58} cy={38} r={22} fill="none" stroke="#64748b" strokeWidth={1.5} />
          {/* Nose */}
          <path d="M 78 38 L 85 42 L 78 46" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinejoin="round" />
          {/* Sight line from eye to phone face */}
          <line
            x1={82} y1={eyeY}
            x2={phoneX - 2} y2={eyeY}
            stroke="#fbbf24" strokeWidth={1} strokeDasharray="3,3" opacity={0.7}
          />
          {/* Neck */}
          <path d="M 48 58 Q 54 68 60 76" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          {/* Torso — slight forward lean, terminates at desk edge to suggest
              the body sitting close to it without drawing a full chair. */}
          <path d="M 60 76 Q 74 96 88 116" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          {/* Near arm (front of body): shoulder → elbow on desk → forearm
              angled up to the near edge of the phone. */}
          <path d="M 60 76 Q 70 80 78 88" fill="none" stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          <line x1={78} y1={88} x2={108} y2={deskY} stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          <line x1={108} y1={deskY} x2={138} y2={phoneBottomY - 2} stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" />
          {/* Far arm — visible as a second forearm angling in from further
              along the desk. Drawing the full far arm with shoulder behind
              the head would clutter the side view, so we keep just the
              forearm + hand. */}
          <line x1={180} y1={deskY} x2={150} y2={phoneBottomY - 2} stroke="#64748b" strokeWidth={1.5} strokeLinecap="round" opacity={0.6} />
          {/* Hands — small ellipses at the bottom corners of the phone */}
          <ellipse cx={138} cy={phoneBottomY - 2} rx={5} ry={3.5} fill="#475569" stroke="#94a3b8" strokeWidth={1.2} />
          <ellipse cx={150} cy={phoneBottomY - 2} rx={5} ry={3.5} fill="#475569" stroke="#94a3b8" strokeWidth={1.2} opacity={0.85} />
          {/* Phone — side-on profile (vertical slab) with the "screen" face
              toward the patient. */}
          <rect x={phoneX} y={phoneTopY} width={8} height={phoneBottomY - phoneTopY} rx={2} fill="#334155" stroke="#64748b" strokeWidth={1} />
          <text x={phoneX + 4} y={phoneTopY - 4} fill="#64748b" fontSize={9} textAnchor="middle">phone</text>
          {/* Fixation dot on phone */}
          <circle cx={phoneX + 0.5} cy={eyeY} r={2.5} fill="#fbbf24" />
          {/* Desk surface (elbow rest) */}
          <line x1={28} y1={deskY} x2={240} y2={deskY} stroke="#475569" strokeWidth={1.5} strokeLinecap="round" />
          <line x1={240} y1={deskY} x2={240} y2={deskY + 12} stroke="#475569" strokeWidth={1} strokeLinecap="round" />
          {/* Distance callout — between eye and phone face, below the sight line */}
          <line
            x1={90} y1={eyeY + 26}
            x2={phoneX} y2={eyeY + 26}
            stroke="#64748b" strokeWidth={1}
            markerStart="url(#phArrowL)" markerEnd="url(#phArrowR)"
          />
          <text
            x={(90 + phoneX) / 2} y={eyeY + 22}
            fill="#94a3b8" fontSize={11} textAnchor="middle" fontWeight={600}
          >
            {viewingDistanceCm} cm
          </text>
        </svg>
        {!compact && (
          <p className="text-xs text-muted text-center">
            Rest your elbows on the desk and hold the phone {viewingDistanceCm} cm from your eye.
            Cover your {coveredEye} eye and look straight at the yellow dot.
          </p>
        )}
      </div>
    )
  }

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
        <p className="text-xs text-muted text-center">
          Sit {viewingDistanceCm} cm from the screen.
          Cover your {coveredEye} eye and look straight at the yellow dot.
        </p>
      )}
    </div>
  )
}
