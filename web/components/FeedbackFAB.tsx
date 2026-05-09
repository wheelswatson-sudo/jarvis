'use client'

import { useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createClient } from '../lib/supabase/client'
import { useTrackEvent } from '../lib/use-track-event'

// Floating "Send feedback" button — pinned bottom-left so it never collides
// with the bottom-right Chat button. Captures the current path so Watson knows
// what surface the user was on when the thought struck.

function deriveTitle(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) return 'Untitled feedback'
  if (firstLine.length <= 80) return firstLine
  const cut = firstLine.slice(0, 80)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + '…'
}

export function FeedbackFAB() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const track = useTrackEvent()

  // Don't show on the dedicated /feedback page — the form there already
  // exists and the FAB would just duplicate the surface.
  if (pathname === '/feedback') return null

  function openPanel() {
    setError(null)
    setSentAt(null)
    setOpen(true)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = body.trim()
    if (!trimmed) {
      setError('Type something first.')
      return
    }
    setSubmitting(true)
    setError(null)
    const sourcePath = pathname ?? '/'
    const description = `${trimmed}\n\n— from ${sourcePath}`
    const title = deriveTitle(trimmed)
    track('feedback_submit', {
      category: 'improvement',
      source: 'fab',
      path: sourcePath,
    })
    try {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        setError('Sign in required.')
        setSubmitting(false)
        return
      }
      const { error: insertError } = await supabase.from('feedback').insert({
        user_id: user.id,
        requester_email: user.email ?? null,
        title,
        description,
        category: 'improvement',
      })
      if (insertError) {
        setError(insertError.message || 'Could not send. Try again.')
        setSubmitting(false)
        return
      }
      setBody('')
      setSubmitting(false)
      setSentAt(Date.now())
      window.setTimeout(() => {
        setOpen(false)
        setSentAt(null)
      }, 1400)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send.')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col items-start sm:left-4">
      {open && (
        <div className="mb-3 flex w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl aiea-glass-strong shadow-2xl shadow-violet-500/10 animate-fade-up">
          <div className="flex items-center justify-between border-b border-white/[0.06] bg-gradient-to-r from-indigo-500/[0.08] via-violet-500/[0.06] to-fuchsia-500/[0.08] px-4 py-3">
            <div className="text-sm font-medium text-zinc-100">
              Send feedback
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
              aria-label="Close feedback"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12" />
                <path d="M6 18L18 6" />
              </svg>
            </button>
          </div>
          {sentAt ? (
            <div className="px-4 py-6 text-center text-sm text-emerald-300">
              Thanks — Watson will see this.
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3 p-4">
              <p className="text-xs text-zinc-500">
                What worked, what didn&apos;t, what would you change?
              </p>
              <textarea
                ref={textareaRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Type a sentence — bug, idea, friction."
                aria-label="Feedback"
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
              />
              {error && <p className="text-xs text-rose-300">{error}</p>}
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-600">
                  from {pathname ?? '/'}
                </span>
                <button
                  type="submit"
                  disabled={submitting || !body.trim()}
                  className="rounded-lg border border-violet-400/30 bg-gradient-to-r from-indigo-500/20 via-violet-500/20 to-fuchsia-500/20 px-3 py-1.5 text-xs font-medium text-violet-100 transition-colors hover:border-violet-400/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label={open ? 'Close feedback' : 'Send feedback'}
        title="Send feedback"
        className={`group inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
          open
            ? 'border border-white/[0.08] bg-white/[0.04] text-zinc-200 backdrop-blur-xl'
            : 'border border-white/[0.06] bg-white/[0.03] text-zinc-300 backdrop-blur-xl hover:border-violet-400/30 hover:bg-white/[0.06] hover:text-zinc-100'
        }`}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {open ? 'Close' : 'Feedback'}
      </button>
    </div>
  )
}
