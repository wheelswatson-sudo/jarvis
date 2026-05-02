'use client'

import { useState, useTransition } from 'react'
import { createClient } from '../../lib/supabase/client'

export type GmailSyncState = {
  last_synced_at: string | null
}

type Props = {
  state: GmailSyncState
}

type GmailMessage = {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  body: string
  date: string
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleString()
}

function decodeBody(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const p = payload as { body?: { data?: string }; parts?: unknown[]; mimeType?: string }
  if (p.body?.data) {
    try {
      return atob(p.body.data.replace(/-/g, '+').replace(/_/g, '/'))
    } catch {
      return ''
    }
  }
  if (Array.isArray(p.parts)) {
    for (const part of p.parts) {
      const text = decodeBody(part)
      if (text) return text
    }
  }
  return ''
}

function getHeader(headers: { name: string; value: string }[] | undefined, name: string): string {
  if (!Array.isArray(headers)) return ''
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
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
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.provider_token
        if (!token) {
          setError('No Google access token. Sign out and back in with Google to grant Gmail access.')
          return
        }

        setStatus('Fetching recent emails…')
        const listRes = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=newer_than:30d',
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!listRes.ok) {
          setError(`Gmail API ${listRes.status} — try reconnecting Google.`)
          return
        }
        const listData = (await listRes.json()) as { messages?: { id: string }[] }
        const ids = (listData.messages ?? []).slice(0, 20).map((m) => m.id)
        if (ids.length === 0) {
          setStatus('No recent emails found.')
          return
        }

        setStatus(`Loading ${ids.length} messages…`)
        const fetched = await Promise.all(
          ids.map(async (id) => {
            const r = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
              { headers: { Authorization: `Bearer ${token}` } },
            )
            if (!r.ok) return null
            const m = (await r.json()) as {
              id: string
              threadId: string
              payload?: { headers?: { name: string; value: string }[] }
            }
            const headers = m.payload?.headers
            const body = decodeBody(m.payload).slice(0, 20000)
            const msg: GmailMessage = {
              id: m.id,
              threadId: m.threadId,
              from: getHeader(headers, 'From'),
              to: getHeader(headers, 'To'),
              subject: getHeader(headers, 'Subject'),
              body,
              date: getHeader(headers, 'Date') || new Date().toISOString(),
            }
            return msg
          }),
        )
        const messages = fetched.filter((m): m is GmailMessage => !!m && !!m.body)

        setStatus(`Extracting commitments from ${messages.length} emails…`)
        const syncRes = await fetch('/api/gmail/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages }),
        })
        const syncData = (await syncRes.json().catch(() => ({}))) as {
          processed?: number
          skipped?: number
          commitments_created?: number
          errors?: number
          sample_errors?: string[]
          error?: string
        }
        if (!syncRes.ok) {
          setError(syncData.error ?? `Sync failed (HTTP ${syncRes.status}).`)
          return
        }
        const matched = syncData.processed ?? 0
        const skipped = syncData.skipped ?? 0
        setStatus(
          `${matched} emails matched contacts — ` +
            `${syncData.commitments_created ?? 0} commitments captured` +
            (skipped ? `, ${skipped} skipped (no matching contact)` : '') +
            (syncData.errors ? `, ${syncData.errors} errors.` : '.'),
        )
        if (syncData.errors && syncData.sample_errors?.length) {
          setError(`First error: ${syncData.sample_errors[0]}`)
        }
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
            <span className="text-sm font-medium text-zinc-100">Gmail commitments</span>
            <span className="rounded-full border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              Manual sync
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Pulls the last 30 days of emails, extracts commitments + sentiment with
            Llama 4 Scout (Groq), and matches each thread to a contact in your
            graph. Reuses your Google sign-in — no extra OAuth.
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
