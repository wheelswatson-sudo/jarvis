'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '../../lib/supabase/client'
import { Brand } from '../../components/Brand'
import { GOOGLE_OAUTH_SCOPES } from '../../lib/google/scopes'

type Mode = 'signin' | 'signup'

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function signInWithGoogle() {
    setGoogleBusy(true)
    setError(null)
    setMessage(null)
    const supabase = createClient()
    // Only force `prompt=consent` on first connect — returning users skip
    // the consent screen. Explicit re-consent lives on Settings → Reconnect
    // Google. `access_type=offline` alone still asks Google for a refresh
    // token; Google reuses the previously-granted scopes silently.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: GOOGLE_OAUTH_SCOPES.join(' '),
        queryParams: {
          access_type: 'offline',
        },
      },
    })
    if (error) {
      setError(error.message)
      setGoogleBusy(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    const supabase = createClient()
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (error) setError(error.message)
      else {
        router.replace('/home')
        router.refresh()
      }
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) setError(error.message)
      else if (data.session) {
        router.replace('/home')
        router.refresh()
      } else {
        setMessage('Check your email to confirm your account.')
      }
    }
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
            Your AI executive assistant for relationship intelligence.
          </p>
        </div>

        <div className="rounded-2xl aiea-glass-strong p-6 shadow-2xl shadow-violet-500/5">
          <button
            type="button"
            onClick={signInWithGoogle}
            disabled={googleBusy || busy}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-zinc-100 transition-all hover:border-white/[0.18] hover:bg-white/[0.06] disabled:opacity-50"
          >
            <GoogleIcon />
            {googleBusy ? 'Redirecting…' : 'Continue with Google'}
          </button>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-white/[0.06]" />
            <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">
              or
            </span>
            <div className="h-px flex-1 bg-white/[0.06]" />
          </div>

          <form onSubmit={submit}>
            <div className="mb-5 flex gap-1 rounded-lg border border-white/[0.05] bg-white/[0.02] p-1 text-sm">
              <button
                type="button"
                onClick={() => setMode('signin')}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  mode === 'signin'
                    ? 'bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/15 text-white shadow-sm ring-1 ring-inset ring-violet-500/30'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => setMode('signup')}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  mode === 'signup'
                    ? 'bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/15 text-white shadow-sm ring-1 ring-inset ring-violet-500/30'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Sign up
              </button>
            </div>

            <label className="mb-3 block">
              <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                Email
              </span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
              />
            </label>
            <label className="mb-2 block">
              <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                Password
              </span>
              <input
                type="password"
                required
                minLength={8}
                autoComplete={
                  mode === 'signin' ? 'current-password' : 'new-password'
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
              />
            </label>
            {mode === 'signin' && (
              <div className="mb-5 flex justify-end">
                <Link
                  href="/forgot-password"
                  className="text-[11px] text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
            )}
            {error && (
              <p className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/[0.08] px-3 py-2 text-sm text-rose-300">
                {error}
              </p>
            )}
            {message && (
              <p className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.08] px-3 py-2 text-sm text-emerald-300">
                {message}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || googleBusy}
              className="w-full rounded-lg aiea-cta px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-[11px] text-zinc-600">
          By continuing you agree to keep your data private and secure.
        </p>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" width={16} height={16} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.32A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.71A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.17.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 9 0 9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  )
}
