import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../AuthContext'
import { ApiError, requestPasswordReset, confirmPasswordReset } from '../api'

interface Props {
  onClose: () => void
}

export function AuthModal({ onClose }: Props) {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset-sent' | 'reset-confirm'>('login')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Check URL for resetToken on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('resetToken')
    if (token) {
      setResetToken(token)
      setMode('reset-confirm')
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  // Focus trap + escape key
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement

    // Focus first input on open
    const timer = setTimeout(() => {
      const firstInput = dialogRef.current?.querySelector<HTMLElement>('input, button[type="submit"]')
      firstInput?.focus()
    }, 50)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }

      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'input, button, textarea, [tabindex]:not([tabindex="-1"])'
        )
        const first = focusable[0]
        const last = focusable[focusable.length - 1]

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [onClose])

  const title = mode === 'login' ? 'Sign in'
    : mode === 'register' ? 'Create account'
    : mode === 'forgot' ? 'Reset password'
    : mode === 'reset-sent' ? 'Check your email'
    : 'Set new password'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'login') {
        await login(email, password)
        onClose()
      } else if (mode === 'register') {
        await register(email, displayName || email.split('@')[0], password)
        onClose()
      } else if (mode === 'forgot') {
        await requestPasswordReset(email)
        setMode('reset-sent')
      } else if (mode === 'reset-confirm') {
        await confirmPasswordReset(resetToken, newPassword)
        setMode('login')
        setError('')
        setPassword('')
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="bg-surface border border-white/[0.08] rounded-2xl p-7 w-full max-w-sm space-y-5 shadow-2xl animate-page-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id="auth-modal-title" className="text-lg font-heading font-bold text-white">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white text-xl leading-none min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-elevated transition-colors"
            aria-label="Close dialog"
          >
            &times;
          </button>
        </div>

        <p className="text-zinc-400 text-sm">
          {mode === 'login' && 'Sign in to sync your results across devices.'}
          {mode === 'register' && 'Create a free account to save your results in the cloud.'}
          {mode === 'forgot' && 'Enter your email and we\'ll send you a reset link.'}
          {mode === 'reset-sent' && 'If an account exists with that email, you\'ll receive a password reset link shortly. Check your inbox (and spam folder).'}
          {mode === 'reset-confirm' && 'Choose a new password for your account.'}
        </p>

        {error && (
          <div role="alert" className="text-red-400 text-sm bg-red-900/15 border border-red-800/25 rounded-xl px-3 py-2 flex items-start gap-2">
            <svg className="w-4 h-4 mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
            </svg>
            {error}
          </div>
        )}

        {mode === 'reset-sent' ? (
          <button
            onClick={() => { setMode('login'); setError('') }}
            className="w-full py-2.5 btn-primary rounded-xl text-sm font-medium text-white"
          >
            Back to sign in
          </button>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {(mode === 'login' || mode === 'register' || mode === 'forgot') && (
              <div className="space-y-1.5">
                <label htmlFor="auth-email" className="text-xs font-medium text-zinc-400">Email</label>
                <input
                  id="auth-email"
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="input-field"
                />
              </div>
            )}
            {mode === 'register' && (
              <div className="space-y-1.5">
                <label htmlFor="auth-display-name" className="text-xs font-medium text-zinc-400">
                  Display name <span className="text-zinc-600">(optional)</span>
                </label>
                <input
                  id="auth-display-name"
                  type="text"
                  placeholder="How we show your name"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  autoComplete="name"
                  className="input-field"
                />
              </div>
            )}
            {(mode === 'login' || mode === 'register') && (
              <div className="space-y-1.5">
                <label htmlFor="auth-password" className="text-xs font-medium text-zinc-400">
                  Password {mode === 'register' && <span className="text-zinc-600">(min 8 characters)</span>}
                </label>
                <input
                  id="auth-password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  className="input-field"
                />
              </div>
            )}
            {mode === 'reset-confirm' && (
              <div className="space-y-1.5">
                <label htmlFor="auth-new-password" className="text-xs font-medium text-zinc-400">
                  New password <span className="text-zinc-600">(min 8 characters)</span>
                </label>
                <input
                  id="auth-new-password"
                  type="password"
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className="input-field"
                />
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full py-2.5 btn-primary disabled:opacity-50 rounded-xl text-sm font-medium text-white"
            >
              {loading
                ? mode === 'login' ? 'Signing in…' : mode === 'register' ? 'Creating account…' : mode === 'forgot' ? 'Sending…' : 'Saving…'
                : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Set new password'}
            </button>
          </form>
        )}

        {mode === 'login' && (
          <div className="text-center space-y-2">
            <button
              onClick={() => { setMode('forgot'); setError('') }}
              className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors min-h-[44px] px-2"
            >
              Forgot password?
            </button>
            <p className="text-zinc-500 text-xs">
              No account?{' '}
              <button onClick={() => { setMode('register'); setError('') }} className="text-accent hover:text-accent-light min-h-[44px] px-1">
                Create one
              </button>
            </p>
          </div>
        )}

        {mode === 'register' && (
          <p className="text-center text-zinc-500 text-xs">
            Already have an account?{' '}
            <button onClick={() => { setMode('login'); setError('') }} className="text-accent hover:text-accent-light min-h-[44px] px-1">
              Sign in
            </button>
          </p>
        )}

        {(mode === 'forgot' || mode === 'reset-confirm') && (
          <p className="text-center text-zinc-500 text-xs">
            <button onClick={() => { setMode('login'); setError('') }} className="text-accent hover:text-accent-light min-h-[44px] px-1">
              Back to sign in
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
