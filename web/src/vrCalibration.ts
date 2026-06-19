import type { VrCalibration, VrHeadsetPreset } from './types'

/**
 * Phone-in-headset (`phone-vr`) lens presets.
 *
 * A passive optical headset splits the phone screen into two lens
 * halves. The single number that actually matters
 * for stimulus geometry is the lens separation — the distance between
 * the two lens optical centers — because that sets where the fixation
 * dot must sit so it falls at the center of the user's view through the
 * active lens.
 *
 * We express the default separation as a fraction of the landscape
 * viewport width rather than a fixed pixel count: phones vary enormously
 * in CSS-pixel width, and "half the screen width" reliably centers each
 * lens within its own half on any device. The user can then nudge it,
 * because real headset cradles, IPDs, and phone placements vary.
 */

/** Slider bounds for the manual lens-separation control (as a fraction
 *  of viewport width). The lens centers can't be pushed past the screen
 *  edges, and pulling them too close together collapses the usable field
 *  on the temporal side. */
export const VR_LENS_SEPARATION_FRACTION = { min: 0.3, max: 0.9, default: 0.5 } as const

/** Slider bound (± px) for the vertical lens-center offset. Phones rarely
 *  sit perfectly centered in the cradle, but the play is small. */
export const VR_LENS_Y_OFFSET_MAX_PX = 80

/** Optical specification for a passive phone-VR headset.
 *  All values are the working midpoints of the manufacturer's published
 *  adjustment/tolerance ranges. */
export interface VrHeadsetSpec {
  /** Effective lens focal length (mm). The phone screen sits ~at this
   *  focal plane, so this — NOT a physical viewing distance — sets the
   *  angular scale of on-screen features. See `vrPixelsPerDegree`. */
  focalLengthMm: number
  /** Default interpupillary distance (mm); fixes where each lens center,
   *  and therefore each eye's fixation dot, sits relative to screen
   *  center. See `vrDefaultLensSeparationFraction`. */
  ipdMm: number
  /** Manufacturer field of view (full angle, degrees). Half of this caps
   *  the largest eccentricity the optics can present. */
  fovDeg: number
  /** Lens clear-aperture diameter (mm). */
  lensDiameterMm: number
}

/** Per-preset optics. The `standard` defaults match a typical passive phone-VR
 *  viewer (measured against the VR Shinecon SC-G04DB): IPD 62 mm, lens-to-screen
 *  focal distance 49 mm, FOV 90–100° (95° midpoint), 40 mm aspheric resin lens.
 *  The focal distance is the dominant angular-scale lever — `pxPerMm` from the
 *  bank-card calibration is focal-independent, so a wrong focal length directly
 *  over/under-states every reported eccentricity. `custom` starts from the same
 *  numbers; the user adjusts the lens geometry by hand. */
export const VR_HEADSET_SPECS: Record<VrHeadsetPreset, VrHeadsetSpec> = {
  standard: { focalLengthMm: 49, ipdMm: 62, fovDeg: 95, lensDiameterMm: 40 },
  custom: { focalLengthMm: 49, ipdMm: 62, fovDeg: 95, lensDiameterMm: 40 },
}

/**
 * Near-axis pixels-per-degree for a phone-in-headset run.
 *
 * A passive headset is a magnifier with the screen ~at the lens focal
 * plane, so an on-screen feature `x` mm off the optical axis subtends a
 * visual angle θ = arctan(x / f). The angular scale near the axis is
 * therefore set by the lens FOCAL LENGTH, not by any physical
 * eye-to-screen distance:
 *
 *   pixelsPerDegree ≈ pxPerMm · f · tan(1°)
 *
 * This differs fundamentally from the standard (naked-eye) model
 * `pxPerMm · viewingDistance · tan(1°)`: with f ≈ 42 mm versus a ~300 mm
 * arm's-length distance, the headset packs ~7× more degrees onto the
 * same screen. Downstream `degToPx` cancels viewing distance, so feeding
 * this value through is sufficient to make VR geometry correct.
 */
export function vrPixelsPerDegree(pxPerMm: number, focalLengthMm: number): number {
  return pxPerMm * focalLengthMm * Math.tan(Math.PI / 180)
}

/** Half the headset's field of view — the largest eccentricity the
 *  optics can present. Used to cap the geometric screen-edge scan so the
 *  run never claims a field wider than the lenses actually deliver. */
export function vrMaxFieldHalfDeg(preset: VrHeadsetPreset): number {
  return VR_HEADSET_SPECS[preset].fovDeg / 2
}

/** Starting lens-separation fraction derived from the headset IPD.
 *  The fixation dot must fall on each lens's optical center, which sits
 *  IPD/2 from screen center, so the separation in px is IPD·pxPerMm. We
 *  return it as a fraction of viewport width (the slider's unit), clamped
 *  to the slider range. Falls back to the neutral default if the inputs
 *  aren't measured yet. */
export function vrDefaultLensSeparationFraction(
  preset: VrHeadsetPreset,
  pxPerMm: number,
  viewportWidthPx: number,
): number {
  if (!(pxPerMm > 0) || !(viewportWidthPx > 0)) return VR_LENS_SEPARATION_FRACTION.default
  const ipdPx = VR_HEADSET_SPECS[preset].ipdMm * pxPerMm
  const frac = ipdPx / viewportWidthPx
  return Math.max(
    VR_LENS_SEPARATION_FRACTION.min,
    Math.min(VR_LENS_SEPARATION_FRACTION.max, frac),
  )
}

/** Build a starting VR calibration for a preset given the current
 *  landscape viewport width. `custom` starts from the same geometry as
 *  the `standard` preset; it just flags that the user intends to adjust. */
export function defaultVrCalibration(
  preset: VrHeadsetPreset,
  viewportWidthPx: number,
): VrCalibration {
  return {
    enabled: true,
    headsetPreset: preset,
    lensSeparationPx: Math.round(viewportWidthPx * VR_LENS_SEPARATION_FRACTION.default),
    lensCenterYOffsetPx: 0,
  }
}

export const VR_PRESET_LABELS: Record<VrHeadsetPreset, string> = {
  standard: 'Standard VR headset',
  custom: 'Custom headset',
}

/** Clamp a user-entered lens separation to the allowed range for the
 *  current viewport width. */
export function clampLensSeparationPx(px: number, viewportWidthPx: number): number {
  const min = viewportWidthPx * VR_LENS_SEPARATION_FRACTION.min
  const max = viewportWidthPx * VR_LENS_SEPARATION_FRACTION.max
  return Math.round(Math.max(min, Math.min(max, px)))
}

/** Clamp a user-entered vertical lens offset to the allowed range. */
export function clampLensYOffsetPx(px: number): number {
  return Math.round(Math.max(-VR_LENS_Y_OFFSET_MAX_PX, Math.min(VR_LENS_Y_OFFSET_MAX_PX, px)))
}
