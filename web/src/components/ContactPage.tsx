import { useState } from 'react'
import { BackButton } from './AccessibleNav'

interface Props {
  onBack: () => void
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export function ContactPage({ onBack }: Props) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to send message.')
      }
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-[100dvh] bg-base text-white safe-pad p-6 animate-page-in">
      <div className="max-w-lg mx-auto space-y-8 pb-12">
        <div className="flex items-center justify-between pb-5 border-b border-white/[0.06]">
          <h1 className="text-3xl font-heading font-bold">Contact</h1>
          <BackButton onClick={onBack} label="Home" />
        </div>

        <p className="text-zinc-400 text-sm leading-relaxed">
          Have a question, suggestion, or just want to say hi? Send me a message and I'll get back to you.
        </p>

        {sent ? (
          <div className="bg-teal/5 border border-teal/15 rounded-2xl p-6 text-center space-y-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-teal/10 flex items-center justify-center border border-teal/20">
              <svg viewBox="0 0 24 24" className="w-6 h-6 text-teal" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <p className="text-teal font-heading font-semibold">Message sent!</p>
            <p className="text-zinc-400 text-sm">Thanks for reaching out. I'll get back to you as soon as I can.</p>
            <button
              onClick={() => { setSent(false); setName(''); setEmail(''); setMessage('') }}
              className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Send another message
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="text-red-400 text-sm bg-red-900/15 border border-red-800/25 rounded-xl px-3 py-2">
                {error}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="contact-name" className="text-sm text-zinc-400">Name</label>
              <input
                id="contact-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                required
                placeholder="Your name"
                className="input-field"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="contact-email" className="text-sm text-zinc-400">Email</label>
              <input
                id="contact-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="your@email.com"
                className="input-field"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="contact-message" className="text-sm text-zinc-400">Message</label>
              <textarea
                id="contact-message"
                value={message}
                onChange={e => setMessage(e.target.value)}
                required
                rows={5}
                placeholder="What's on your mind?"
                className="input-field resize-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 btn-primary disabled:opacity-50 rounded-xl text-sm font-medium text-white"
            >
              {loading ? 'Sending...' : 'Send message'}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
