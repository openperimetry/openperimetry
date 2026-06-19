import type { VrViewport } from '../vrGeometry'

/**
 * Phone-in-headset overlay drawn on top of a test surface.
 *
 * The test renderers (Goldmann / Static) already place fixation and
 * stimuli relative to screen center, and in VR mode the active-lens
 * geometry is folded into `calibration.fixationOffsetPx` +
 * `maxEccentricityDeg`, so stimuli stay inside the active lens half.
 * This overlay adds the two things the renderers don't do on their own:
 *
 *   1. A solid-black mask over the *inactive* lens half, so the eye that
 *      isn't being tested looks at darkness (no grey perimetry field, no
 *      binocular rivalry).
 *   2. An optional center divider, shown only during setup/instruction
 *      phases so the user can confirm the phone is centered in the
 *      cradle. It's hidden once stimuli start, where any line near the
 *      meridian would be a distraction.
 *
 * Both layers are `pointer-events-none` so taps fall through to the test
 * surface's "I saw it" / pause handlers underneath.
 */
export function VrTestSurface({
  viewport,
  innerWidth,
  showDivider,
}: {
  viewport: VrViewport
  innerWidth: number
  showDivider: boolean
}) {
  // Inactive half is the complement of the active lens half. Active spans
  // [originX, originX + width]; the inactive rectangle is whichever side
  // is left over (there's only one — the active half is always exactly
  // half the screen).
  const activeLeft = viewport.originX
  const activeRight = viewport.originX + viewport.width
  const inactiveLeft = activeLeft <= 0 ? activeRight : 0
  const inactiveWidth = activeLeft <= 0 ? innerWidth - activeRight : activeLeft

  return (
    <>
      <div
        className="absolute top-0 bg-black pointer-events-none"
        style={{
          left: inactiveLeft,
          width: inactiveWidth,
          height: '100%',
          zIndex: 20,
        }}
        aria-hidden
      />
      {showDivider && (
        <div
          className="absolute top-0 pointer-events-none"
          style={{
            left: innerWidth / 2 - 0.5,
            width: 1,
            height: '100%',
            backgroundColor: '#334155',
            zIndex: 21,
          }}
          aria-hidden
        />
      )}
    </>
  )
}
