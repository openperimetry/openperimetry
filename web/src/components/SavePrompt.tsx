import { useAuth } from '../AuthContext'

/**
 * Shown on the results screen after a test completes.
 *
 * Signed-in users see a confirmation that the result was saved to their
 * account (the "Results" history page will list it and server sync runs
 * automatically). Anonymous users see calls to create an account or
 * sign in — this is the only way their result will be kept, because
 * anonymous results are intentionally ephemeral (see storage.ts).
 *
 * The auth buttons dispatch a `vfc:show-auth` window event that App.tsx
 * listens for to open the auth modal. Using an event keeps this
 * component prop-free so it can be dropped into any test screen.
 */
export function SavePrompt() {
  const { user } = useAuth()

  if (user) {
    return (
      <p className="text-center text-green-400 text-xs">
        Saved automatically — this result is now available on the Results page.
      </p>
    )
  }

  const openAuth = (mode: 'login' | 'register') => {
    window.dispatchEvent(new CustomEvent('vfc:show-auth', { detail: { mode } }))
  }

  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-100/90 space-y-2">
      <p className="leading-relaxed">
        This result is only kept on this screen. Create a free account or
        sign in to save it and track changes over time across devices.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          onClick={() => openAuth('register')}
          className="w-full py-2 btn-primary rounded-md text-sm font-medium text-white"
        >
          Create account
        </button>
        <button
          onClick={() => openAuth('login')}
          className="w-full py-2 rounded-md border border-line bg-subtle text-sm font-medium text-ink hover:bg-subtle-2 hover:text-ink transition-colors"
        >
          Sign in
        </button>
      </div>
    </div>
  )
}
