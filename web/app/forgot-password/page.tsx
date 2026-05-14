'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '../../lib/supabase/client'
import { Brand } from '../../components/Brand'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const supabase = createClient()

    // Route the recovery link through /auth/callback (which exchanges the
    // PKCE code for a session) and then forward to /reset-password where the
    // user picks a new password under that fresh session.
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    })

    // Always show the same confirmation regardless of whether the email
    // exists — Supabase masks this server-side too, but we don't surface
    // *any* failure here either, so a rate-limit hit doesn't leak account
    // state. The user retries from email if nothing arrives.
    setSubmitted(true)
    setBusy(false)
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
      <div className="aiea-aurora-bg" aria-hidden="true" />
      <div className="aiea-grid pointer-events-none fixed inset-0 z-0 opacity-50" aria-hidden="true" />

      <div className="relative z-10 w-full max-w-sm animate-fade-up">
        <div className="mb-10 flex flex-col items-center text-center">
          <div className="mb-4 animate-float">
            <Brand size="lg" />
          </div>
          <p className="text-sm text-zinc-400">
            Reset your password.
          </p>
        </div>

        <div className="rounded-2xl aiea-glass-strong p-6 shadow-2xl shadow-violet-500/5">
          {submitted ? (
            <div className="space-y-4 text-center">
              <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.08] px-3 py-3 text-sm text-emerald-300">
                If an account exists for <span className="font-medium">{email}</span>, a password reset link is on its way. Check your inbox (and spam).
              </p>
              <Link
                href="/login"
                className="inline-block text-xs text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={submit}>
              <p className="mb-5 text-xs text-zinc-400">
                Enter the email you signed in with. We&apos;ll send you a link to choose a new password.
              </p>
              <label className="mb-5 block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                  Email
                </span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg aiea-cta px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <div className="mt-5 text-center">
                <Link
                  href="/login"
                  className="text-xs text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
                >
                  Back to sign in
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
