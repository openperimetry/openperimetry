import type { VrCalibration } from './types'

/**
 * Active-lens viewport geometry for phone-in-headset (`phone-vr`) runs.
 *
 * A passive headset splits the landscape phone screen down the middle:
 * the left eye looks through the left lens at the left half, the right
 * eye through the right lens at the right half. Only one half is active
 * at a time (sequential both-eye testing runs one half, then the other);
 * the inactive half stays dark.
 *
 * The renderers in GoldmannTest / StaticTest already place fixation and
 * stimuli relative to the *full screen center*, so rather than rewrite
 * their coordinate model we hand them:
 *   - where the active lens center sits relative to screen center
 *     (`fixationXFromScreenCenter` / `fixationYFromScreenCenter`), and
 *   - the active half's rectangle (`originX/originY/width/height`),
 * from which edge/eccentricity math is clamped to the lens half instead
 * of the whole phone screen.
 */
export interface VrViewport {
  /** Top-left of the active lens half, in absolute viewport px. */
  originX: number
  originY: number
  /** Active lens half dimensions, in viewport px. */
  width: number
  height: number
  /** Active lens center offset from the full screen center (px).
   *  Positive x = right of center, positive y = down. Fixation is placed
   *  here so it falls at the optical center of the active lens. */
  fixationXFromScreenCenter: number
  fixationYFromScreenCenter: number
}

/** Screen-center-relative bounds of a rectangle, used for ray-to-edge
 *  eccentricity math. All values are px offsets from the screen center
 *  (left/top negative, right/bottom positive). */
export interface CenterBounds {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * Compute the active lens viewport for the tested eye.
 *
 * @param innerWidth  Landscape viewport width (px).
 * @param innerHeight Landscape viewport height (px).
 * @param eye         Eye being tested — selects which half is active.
 * @param vr          Lens calibration (separation + vertical offset).
 */
export function computeVrViewport(
  innerWidth: number,
  innerHeight: number,
  eye: 'left' | 'right',
  vr: VrCalibration,
): VrViewport {
  const halfW = innerWidth / 2
  // Left eye → left half [0, halfW); right eye → right half [halfW, W).
  const originX = eye === 'right' ? halfW : 0
  const lensSign = eye === 'right' ? 1 : -1
  return {
    originX,
    originY: 0,
    width: halfW,
    height: innerHeight,
    fixationXFromScreenCenter: lensSign * (vr.lensSeparationPx / 2),
    fixationYFromScreenCenter: vr.lensCenterYOffsetPx,
  }
}

/** Active half bounds expressed relative to the full screen center, for
 *  clamping stimulus start positions to the lens half. */
export function vrCenterBounds(
  viewport: VrViewport,
  innerWidth: number,
  innerHeight: number,
): CenterBounds {
  return {
    left: viewport.originX - innerWidth / 2,
    right: viewport.originX + viewport.width - innerWidth / 2,
    top: viewport.originY - innerHeight / 2,
    bottom: viewport.originY + viewport.height - innerHeight / 2,
  }
}

/** Full-screen bounds (standard, non-VR) relative to screen center. */
export function fullScreenCenterBounds(innerWidth: number, innerHeight: number): CenterBounds {
  return {
    left: -innerWidth / 2,
    right: innerWidth / 2,
    top: -innerHeight / 2,
    bottom: innerHeight / 2,
  }
}

/**
 * Eccentricity (px) from a fixation point to the bounds edge along a
 * meridian ray. Shared by standard and VR modes — pass full-screen
 * bounds for standard, active-lens bounds for VR. Screen Y is inverted
 * (meridian 90° points up).
 */
export function rayToBoundsPx(
  meridianDeg: number,
  fixXFromCenter: number,
  fixYFromCenter: number,
  bounds: CenterBounds,
): number {
  const rad = (meridianDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = -Math.sin(rad) // screen Y inverted

  let tMin = Infinity
  if (cos > 0.001) tMin = Math.min(tMin, (bounds.right - fixXFromCenter) / cos)
  if (cos < -0.001) tMin = Math.min(tMin, (bounds.left - fixXFromCenter) / cos)
  if (sin > 0.001) tMin = Math.min(tMin, (bounds.bottom - fixYFromCenter) / sin)
  if (sin < -0.001) tMin = Math.min(tMin, (bounds.top - fixYFromCenter) / sin)

  if (!isFinite(tMin) || tMin <= 0) tMin = (bounds.right - bounds.left) / 2
  return tMin
}

/** Largest eccentricity (deg) reachable from the active lens fixation to
 *  the lens-half edges, scanned over all meridians. Used to set the VR
 *  run's `maxEccentricityDeg`.
 *
 *  The px→deg conversion mirrors `degToPx`'s default (sphericity-
 *  corrected) projection `px = pixelsPerDegree · (180/π) · tan(θ)`, so
 *  the reported maximum is the eccentricity the renderer will actually
 *  place at the lens edge — not a linear over-estimate. This matters in
 *  VR because the focal-length-derived `pixelsPerDegree` is small, so the
 *  edge sits at large angles where linear and tangent diverge sharply. */
export function vrMaxEccentricityDeg(
  viewport: VrViewport,
  innerWidth: number,
  innerHeight: number,
  pixelsPerDegree: number,
): number {
  const bounds = vrCenterBounds(viewport, innerWidth, innerHeight)
  let maxPx = 0
  for (let deg = 0; deg < 360; deg += 5) {
    maxPx = Math.max(
      maxPx,
      rayToBoundsPx(deg, viewport.fixationXFromScreenCenter, viewport.fixationYFromScreenCenter, bounds),
    )
  }
  const rad = Math.atan((maxPx * Math.PI) / (pixelsPerDegree * 180))
  return (rad * 180) / Math.PI
}
