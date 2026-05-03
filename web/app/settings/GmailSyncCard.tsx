'use client'

import { useState, useTransition } from 'react'

export type GmailSyncState = {
  last_synced_at: string | null
}

type Props = {
  state: GmailSyncState
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleString()
}

export function GmailSyncCard({ state }: Props) {
  const [isPending, startTransition] = useTransition()
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function syncNow() {
    setStatus(null)
    setError(null)
    startTransition(async () => {
      try {
        setStatus('Fetching recent emails…')
        // Server-side: pulls Gmail using the persisted refresh token,
        // inserts into the unified inbox, and fans out to the commitment
        // extractor. No token handling on the browser.
        const res = await fetch('/api/google/gmail/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: 90, max: 25 }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          fetched?: number
          imported?: number
          skipped?: number
          errors?: number
          commitments_created?: number | null
          commitment_errors?: number
          error?: string
          code?: string
        }
        if (!res.ok) {
          if (data.code === 'reconnect_required') {
            setError(
              'Google connection expired or revoked. Click "Reconnect Google" above.',
            )
          } else {
            setError(data.error ?? `Sync failed (HTTP ${res.status}).`)
          }
          return
        }
        const fetched = data.fetched ?? 0
        const imported = data.imported ?? 0
        const skipped = data.skipped ?? 0
        const commitments = data.commitments_created ?? 0
        if (fetched === 0) {
          setStatus('No recent emails found.')
          return
        }
        setStatus(
          `Fetched ${fetched} email${fetched === 1 ? '' : 's'} · ` +
            `${imported} new in inbox · ` +
            `${commitments} commitments captured` +
            (skipped ? ` · ${skipped} duplicates` : '') +
            (data.errors ? ` · ${data.errors} errors.` : '.'),
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sync failed.')
      }
    })
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GmailGlyph />
            <span className="text-sm font-medium text-zinc-100">Gmail sync</span>
            <span className="rounded-full border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              Manual
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Pulls the last 90 days of emails into the unified inbox
            (filtering noreply/marketing senders) and extracts commitments +
            sentiment per thread. Authentication is automatic — your Google
            connection refreshes silently.
          </p>
          <dl className="mt-3 space-y-1 text-xs text-zinc-400">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-zinc-500">Last sync</dt>
              <dd className="text-zinc-300">{formatTimestamp(state.last_synced_at)}</dd>
            </div>
          </dl>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={syncNow}
            disabled={isPending}
            className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-indigo-500/30 hover:from-indigo-400 hover:to-violet-400 disabled:opacity-50 transition-all"
          >
            {isPending ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>

      {status && <p className="mt-3 text-xs text-emerald-400">{status}</p>}
      {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}
    </div>
  )
}

function GmailGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path fill="#EA4335" d="M2 6.5L12 13l10-6.5V18a2 2 0 01-2 2H4a2 2 0 01-2-2V6.5z" />
      <path fill="#FBBC04" d="M2 6.5L12 13l10-6.5V6a2 2 0 00-2-2H4a2 2 0 00-2 2v.5z" />
    </svg>
  )
}
