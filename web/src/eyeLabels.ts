// web/src/eyeLabels.ts — clinical eye-label formatting (OD / OS / OU).
//
// Used in every place we display an eye badge, filename, or PDF header.
// OD = oculus dexter = right; OS = oculus sinister = left; OU = oculus
// uterque = both. The tooltip text matches so screen readers get the
// full expansion.

import type { Eye, StoredEye } from './types'

export type EyeLabel = 'OD' | 'OS' | 'OU'

export const EYE_LABEL_EXPANSIONS: Record<EyeLabel, string> = {
  OD: 'Oculus Dexter (right eye)',
  OS: 'Oculus Sinister (left eye)',
  OU: 'Oculus Uterque (both eyes)',
}

/** Format a stored single-eye value as OD/OS. Accepts StoredEye only —
 *  use formatEyeLabelForResult if the caller has the Eye type that
 *  includes 'both'. */
export function formatEyeLabel(eye: StoredEye): 'OD' | 'OS' {
  return eye === 'right' ? 'OD' : 'OS'
}

/** Pick an OD/OS/OU label for a result that may represent one eye or
 *  both. Accepts either a StoredEye + explicit binocular flag, or an
 *  Eye value where 'both' is the binocular signal. */
export function formatEyeLabelForResult(eye: Eye, isBinocular?: boolean): EyeLabel
export function formatEyeLabelForResult(eye: StoredEye, isBinocular: boolean): EyeLabel
export function formatEyeLabelForResult(eye: Eye, isBinocular?: boolean): EyeLabel {
  if (eye === 'both' || isBinocular) return 'OU'
  return formatEyeLabel(eye)
}

/** Long-form label for accessibility: "Right eye (OD)" / "Left eye (OS)" / "Both eyes (OU)". */
export function formatEyeLabelLong(eye: Eye, isBinocular = false): string {
  if (eye === 'both' || isBinocular) return 'Both eyes (OU)'
  return eye === 'right' ? 'Right eye (OD)' : 'Left eye (OS)'
}

/** Filename-safe eye component, e.g. "OD" for `vf_2026-04-15_OD_goldmann.ovfx.json`. */
export function eyeLabelForFilename(eye: StoredEye, isBinocular = false): EyeLabel {
  return isBinocular ? 'OU' : formatEyeLabel(eye)
}
