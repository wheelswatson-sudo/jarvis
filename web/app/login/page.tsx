'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../../lib/supabase/client'
import { Brand } from '../../components/Brand'

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
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    if (error) {
      setError(error.message)
      setGoogleBusy(false)
    }
    // On success the browser is redirected to Google — no further work here.
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
        router.replace('/')
        router.refresh()
      }
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) setError(error.message)
      else if (data.session) {
        router.replace('/')
        router.refresh()
      } else {
        setMessage('Check your email to confirm your account.')
      }
    }
    setBusy(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <Brand size="lg" />
          <p className="mt-2 text-sm text-zinc-500">Relationship intelligence.</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <button
            type="button"
            onClick={signInWithGoogle}
            disabled={googleBusy || busy}
            className="flex w-full items-center justify-center gap-2.5 rounded-md border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            <GoogleIcon />
            {googleBusy ? 'Redirecting…' : 'Continue with Google'}
          </button>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-200" />
            <span className="text-xs uppercase tracking-wide text-zinc-400">
              or
            </span>
            <div className="h-px flex-1 bg-zinc-200" />
          </div>

          <form onSubmit={submit}>
          <div className="mb-5 flex gap-1 rounded-md bg-zinc-100 p-1 text-sm">
            <button
              type="button"
              onClick={() => setMode('signin')}
              className={`flex-1 rounded-md px-3 py-1.5 transition-colors ${
                mode === 'signin' ? 'bg-white text-zinc-900' : 'text-zinc-500'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => setMode('signup')}
              className={`flex-1 rounded-md px-3 py-1.5 transition-colors ${
                mode === 'signup' ? 'bg-white text-zinc-900' : 'text-zinc-500'
              }`}
            >
              Sign up
            </button>
          </div>
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium text-zinc-600">
              Email
            </span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
            />
          </label>
          <label className="mb-5 block">
            <span className="mb-1 block text-xs font-medium text-zinc-600">
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
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
            />
          </label>
          {error && (
            <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          {message && (
            <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {message}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || googleBusy}
            className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
          </form>
        </div>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg
      viewBox="0 0 18 18"
      width={16}
      height={16}
      aria-hidden="true"
    >
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
