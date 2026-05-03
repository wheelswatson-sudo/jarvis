'use client'

import { useState } from 'react'
import { createClient } from '../../lib/supabase/client'
import { GOOGLE_OAUTH_SCOPES } from '../../lib/google/scopes'

export type GoogleService = {
  key: 'gmail' | 'calendar' | 'tasks' | 'contacts'
  label: string
  last_synced_at: string | null
  account_email: string | null
}

type Props = {
  account_email: string | null
  services: GoogleService[]
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleString()
}

// Single-button "Connect Google" entry point. Re-uses Supabase OAuth — same
// consent screen as the login page — so the access token lands in
// session.provider_token where every Gmail / Calendar / Tasks / Contacts
// route handler reads it. Use this when the user has already signed in via
// password and wants to add Google scopes, or to re-grant after a token
// expires.
export function GoogleConnectCard({ account_email, services }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reconnect() {
    setBusy(true)
    setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=/settings`,
        scopes: GOOGLE_OAUTH_SCOPES.join(' '),
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    })
    if (error) {
      setError(error.message)
      setBusy(false)
    }
  }

  const anyConnected = services.some((s) => s.last_synced_at)

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GoogleGlyph />
            <span className="text-sm font-medium text-zinc-100">Google Workspace</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                anyConnected
                  ? 'border-emerald-700/60 bg-emerald-900/30 text-emerald-300'
                  : 'border-zinc-700 bg-zinc-800/50 text-zinc-400'
              }`}
            >
              {anyConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            One consent screen grants Gmail, Calendar, Tasks, and Contacts
            access. Sign in with Google (or click Reconnect after a token
            expires) and every service below picks up automatically.
          </p>
          {account_email && (
            <p className="mt-2 text-xs text-zinc-400">
              <span className="text-zinc-500">Account: </span>
              <span className="text-zinc-300">{account_email}</span>
            </p>
          )}
          <ul className="mt-3 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {services.map((s) => (
              <li
                key={s.key}
                className="flex items-center justify-between gap-3 rounded border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5"
              >
                <span className="text-zinc-300">{s.label}</span>
                <span
                  className={
                    s.last_synced_at ? 'text-emerald-400' : 'text-zinc-500'
                  }
                >
                  {formatTimestamp(s.last_synced_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={reconnect}
            disabled={busy}
            className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-indigo-500/30 hover:from-indigo-400 hover:to-violet-400 disabled:opacity-50 transition-all"
          >
            {busy
              ? 'Redirecting…'
              : anyConnected
                ? 'Reconnect Google'
                : 'Connect Google'}
          </button>
        </div>
      </div>
      {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}
    </div>
  )
}

function GoogleGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  )
}
