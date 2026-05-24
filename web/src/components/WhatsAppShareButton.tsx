import { APP_URL } from '../branding'

interface Props {
  /**
   * Human-readable message prepended to the app URL. Keep it short — some
   * WhatsApp clients truncate long pre-filled messages and users rarely
   * scroll past the first sentence before hitting send.
   */
  message: string
  /**
   * Defaults to the app's canonical URL. Callers can override (e.g. a
   * deep link to a specific result in the future).
   */
  url?: string
}

const DEFAULT_URL = APP_URL

/**
 * Low-key WhatsApp share link — a small icon + label in the muted footer
 * palette, not a full-width CTA.
 *
 * Placement rationale: the results screen already has a primary action
 * (Export PDF), a secondary action (Done), and an anonymous-research
 * share card. A loud green WhatsApp button competed with all three for
 * attention. Since "tell a friend" is a nice-to-have — not a core
 * action — we render it as a tertiary text link that blends into the
 * footer area and only catches the eye when the user is looking for it.
 *
 * Uses `wa.me` so it works on both the mobile app (deep link) and
 * WhatsApp Web (desktop fallback) without platform sniffing.
 */
export function WhatsAppShareButton({ message, url = DEFAULT_URL }: Props) {
  const text = `${message}\n\n${url}`
  const href = `https://wa.me/?text=${encodeURIComponent(text)}`
  return (
    <div className="flex justify-center">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-[#25D366] transition-colors py-1"
        aria-label="Share on WhatsApp"
      >
        <svg
          viewBox="0 0 24 24"
          className="w-3.5 h-3.5"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M20.52 3.48A11.86 11.86 0 0012.04 0C5.49 0 .15 5.34.15 11.88c0 2.09.55 4.13 1.59 5.93L0 24l6.35-1.67a11.87 11.87 0 005.68 1.45h.01c6.54 0 11.88-5.34 11.88-11.88 0-3.17-1.24-6.15-3.4-8.42zM12.04 21.7h-.01a9.83 9.83 0 01-5.01-1.37l-.36-.21-3.77.99 1.01-3.67-.24-.38a9.82 9.82 0 01-1.51-5.18c0-5.43 4.43-9.85 9.89-9.85 2.64 0 5.12 1.03 6.98 2.9a9.78 9.78 0 012.89 6.97c0 5.44-4.43 9.8-9.87 9.8zm5.42-7.34c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.23-.64.08-.3-.15-1.26-.47-2.4-1.48-.89-.8-1.49-1.78-1.66-2.08-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37s-1.04 1.02-1.04 2.48 1.07 2.88 1.22 3.08c.15.2 2.11 3.22 5.11 4.52.71.31 1.27.49 1.7.63.72.23 1.37.2 1.89.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35z" />
        </svg>
        Share on WhatsApp
      </a>
    </div>
  )
}
