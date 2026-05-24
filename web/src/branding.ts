// web/src/branding.ts — single source of truth for product name, URLs,
// and support contacts. Every user-facing string that mentions the
// product goes through this module so forks can rebrand by setting
// VITE_APP_NAME / VITE_APP_URL / VITE_SUPPORT_EMAIL at build time.
//
// Defaults resolve to the open-source identity (OpenPerimetry at
// localhost). Hosted instances override them at build time via their
// own (private) deploy workflow.

function envString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

export const APP_NAME = envString(import.meta.env.VITE_APP_NAME, 'OpenPerimetry')
export const APP_URL = envString(import.meta.env.VITE_APP_URL, 'http://localhost:5173')

/** Domain only — e.g. "openperimetry.org" — derived from APP_URL if not
 *  explicitly overridden. Used in footer copy and PDF headers where we
 *  don't want the scheme. */
export const APP_DOMAIN = envString(
  import.meta.env.VITE_APP_DOMAIN,
  (() => {
    try {
      return new URL(APP_URL).host
    } catch {
      return 'localhost'
    }
  })(),
)

export const SUPPORT_EMAIL = envString(import.meta.env.VITE_SUPPORT_EMAIL, '')
export const CONTACT_EMAIL = envString(import.meta.env.VITE_CONTACT_EMAIL, SUPPORT_EMAIL)

/** Version string baked in at build time (CI sets VITE_APP_VERSION from
 *  the git sha or release tag). Used in the OVFX `software.version`
 *  field. */
export const APP_VERSION = envString(import.meta.env.VITE_APP_VERSION, 'dev')

/** Full git SHA of the currently-deployed build (CI sets this from
 *  github.sha). Empty string in local dev builds. */
export const BUILD_SHA = envString(import.meta.env.VITE_BUILD_SHA, '')

/** ISO-8601 timestamp of when the deployed bundle was built. Empty in
 *  local dev. */
export const BUILD_TIME = envString(import.meta.env.VITE_BUILD_TIME, '')

/** PDF header tagline, e.g. "Goldmann Kinetic Perimetry Self-Check  |  openperimetry.org". */
export const PDF_HEADER_TAGLINE = `Goldmann Kinetic Perimetry Self-Check  |  ${APP_DOMAIN}`

/** Page <title> suffix, e.g. " — OpenPerimetry". Appended by App.tsx PAGE_TITLES. */
export const TITLE_SUFFIX = ` — ${APP_NAME}`

/** Whether to show a support-email link. Forks without an address hide it. */
export const HAS_SUPPORT_EMAIL = SUPPORT_EMAIL.length > 0

/** GitHub repo URL for the "Star on GitHub" link. Empty hides the link. */
export const GITHUB_URL = envString(
  import.meta.env.VITE_GITHUB_URL,
  'https://github.com/openperimetry/openperimetry',
)
export const HAS_GITHUB_LINK = GITHUB_URL.length > 0

/** Repo URL used by the admin build-info card to link a deployed commit
 *  back to its source. Defaults to {@link GITHUB_URL} so public/forks
 *  get a sensible link out of the box; private deployments that build
 *  from a different repo override this via VITE_COMMIT_SOURCE_URL. */
export const COMMIT_SOURCE_URL = envString(
  import.meta.env.VITE_COMMIT_SOURCE_URL,
  GITHUB_URL,
)

/** Canonical short marketing tagline. */
export const APP_TAGLINE = 'Free visual field self-test'

/** Pre-filled WhatsApp share message. Uses the app URL so recipients land
 *  on the right page regardless of how the link was shared. */
export function whatsappShareUrl(customText?: string): string {
  const text = customText ?? `Check out ${APP_NAME} — a free visual field self-test for tracking your peripheral vision: ${APP_URL}`
  return `https://wa.me/?text=${encodeURIComponent(text)}`
}
