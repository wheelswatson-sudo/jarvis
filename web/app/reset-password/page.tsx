'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '../../lib/supabase/client'
import { Brand } from '../../components/Brand'

type Status = 'checking' | 'ready' | 'no-session'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [status, setStatus] = useState<Status>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reaching this page directly (no recovery email click) means there's no
  // active session to update — short-circuit with a friendly nudge instead
  // of letting updateUser fail with an opaque auth error.
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      setStatus(data.user ? 'ready' : 'no-session')
    })
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError(updateError.message)
      setBusy(false)
      return
    }
    // The recovery session is still active — go straight to /home rather
    // than forcing a redundant sign-in with the password they just set.
    router.replace('/home')
    router.refresh()
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
            {status === 'no-session'
              ? 'Reset link expired or already used.'
              : 'Choose a new password.'}
          </p>
        </div>

        <div className="rounded-2xl aiea-glass-strong p-6 shadow-2xl shadow-violet-500/5">
          {status === 'checking' && (
            <p className="text-center text-sm text-zinc-400">Verifying reset link…</p>
          )}

          {status === 'no-session' && (
            <div className="space-y-4 text-center">
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-3 text-sm text-amber-200">
                We couldn&apos;t verify your reset session. The link may have expired or been used already.
              </p>
              <Link
                href="/forgot-password"
                className="inline-block text-xs text-zinc-300 underline-offset-4 hover:text-white hover:underline"
              >
                Request a new reset link
              </Link>
            </div>
          )}

          {status === 'ready' && (
            <form onSubmit={submit}>
              <label className="mb-3 block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                  New password
                </span>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
                />
              </label>
              <label className="mb-5 block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                  Confirm new password
                </span>
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
                />
              </label>
              {error && (
                <p className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/[0.08] px-3 py-2 text-sm text-rose-300">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg aiea-cta px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? 'Updating…' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
