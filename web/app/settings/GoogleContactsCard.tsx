'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../../lib/supabase/client'

export type GoogleContactsState = {
  account_email: string | null
  last_synced_at: string | null
}

type Props = {
  state: GoogleContactsState
}

type SyncResult = {
  inserted: number
  updated: number
  skipped: number
  total_fetched: number
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return date.toLocaleString()
}

export function GoogleContactsCard({ state }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)

  function sync() {
    setSyncStatus(null)
    setSyncError(null)
    startTransition(async () => {
      try {
        const supabase = createClient()
        const {
          data: { session },
        } = await supabase.auth.getSession()
        const token = session?.provider_token
        if (!token) {
          setSyncError(
            'No Google access token. Sign out and back in with Google to grant Contacts access.',
          )
          return
        }

        setSyncStatus('Fetching Google Contacts…')
        const res = await fetch('/api/contacts/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: token }),
        })
        const raw: Partial<SyncResult & { error: string }> = await res
          .json()
          .catch(() => ({}))
        if (!res.ok) {
          setSyncStatus(null)
          setSyncError(
            raw.error ??
              (res.status === 401
                ? 'Google rejected the access token. Sign out and back in with Google.'
                : `Sync failed (HTTP ${res.status}).`),
          )
          return
        }
        const inserted = raw.inserted ?? 0
        const updated = raw.updated ?? 0
        const skipped = raw.skipped ?? 0
        const total = raw.total_fetched ?? 0
        setSyncStatus(
          `Fetched ${total} contact${total === 1 ? '' : 's'} — ` +
            `${inserted} new, ${updated} updated, ${skipped} skipped.`,
        )
        router.refresh()
      } catch (err) {
        setSyncError(err instanceof Error ? err.message : 'Sync failed.')
      }
    })
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GoogleGlyph />
            <span className="text-sm font-medium text-zinc-100">
              Google Contacts
            </span>
            <span className="rounded-full border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              Manual sync
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Pulls names, emails, phones, companies, titles, birthdays,
            addresses, and photos via the Google People API. Reuses your
            Google sign-in — no extra OAuth. Re-syncing won’t create
            duplicates — we match on email.
          </p>
          <dl className="mt-3 space-y-1 text-xs text-zinc-400">
            {state.account_email && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-zinc-500">Account</dt>
                <dd className="truncate text-zinc-300">
                  {state.account_email}
                </dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-zinc-500">Last sync</dt>
              <dd className="text-zinc-300">
                {formatTimestamp(state.last_synced_at)}
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={sync}
            disabled={isPending}
            className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-indigo-500/30 hover:from-indigo-400 hover:to-violet-400 disabled:opacity-50 transition-all"
          >
            {isPending ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>

      {syncStatus && (
        <p className="mt-3 text-xs text-emerald-400">{syncStatus}</p>
      )}
      {syncError && <p className="mt-3 text-xs text-rose-400">{syncError}</p>}
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
