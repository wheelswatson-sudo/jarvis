'use client'

import { useState, useTransition } from 'react'

export type CalendarSyncState = {
  last_synced_at: string | null
}

type Props = {
  state: CalendarSyncState
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleString()
}

export function CalendarSyncCard({ state }: Props) {
  const [isPending, startTransition] = useTransition()
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState(state.last_synced_at)

  function syncNow() {
    setStatus(null)
    setError(null)
    startTransition(async () => {
      try {
        setStatus('Fetching calendar events…')
        const res = await fetch('/api/google/calendar/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ past_days: 7, future_days: 30 }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          fetched?: number
          upserted?: number
          skipped?: number
          errors?: number
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
        const upserted = data.upserted ?? 0
        const skipped = data.skipped ?? 0
        setLastSyncedAt(new Date().toISOString())
        if (fetched === 0) {
          setStatus('No calendar events found in this window.')
          return
        }
        setStatus(
          `Fetched ${fetched} event${fetched === 1 ? '' : 's'} · ` +
            `${upserted} saved` +
            (skipped ? ` · ${skipped} skipped` : '') +
            (data.errors ? ` · ${data.errors} errors.` : '.'),
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sync failed.')
      }
    })
  }

  return (
    <div className="rounded-2xl aiea-glass p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CalendarGlyph />
            <span className="text-sm font-medium text-zinc-100">
              Calendar sync
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              Manual
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Pulls the past 7 days and next 30 days of Google Calendar events
            into your timeline. Authentication is automatic — your Google
            connection refreshes silently.
          </p>
          <dl className="mt-3 space-y-1 text-xs text-zinc-400">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-zinc-500">Last sync</dt>
              <dd className="text-zinc-300">{formatTimestamp(lastSyncedAt)}</dd>
            </div>
          </dl>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={syncNow}
            disabled={isPending}
            className="rounded-lg aiea-cta px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            {isPending ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>

      {status && <p className="mt-3 text-xs text-emerald-300">{status}</p>}
      {error && <p className="mt-3 text-xs text-rose-300">{error}</p>}
    </div>
  )
}

function CalendarGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="16" rx="2" fill="#4285F4" />
      <rect x="3" y="5" width="18" height="4" fill="#1A73E8" />
      <rect x="6" y="2" width="2" height="5" rx="1" fill="#1A73E8" />
      <rect x="16" y="2" width="2" height="5" rx="1" fill="#1A73E8" />
      <rect x="6" y="11" width="3" height="3" fill="white" />
      <rect x="11" y="11" width="3" height="3" fill="white" />
      <rect x="16" y="11" width="3" height="3" fill="white" />
      <rect x="6" y="16" width="3" height="3" fill="white" />
      <rect x="11" y="16" width="3" height="3" fill="white" />
    </svg>
  )
}
