'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export type ApolloState = {
  connected: boolean
  masked_key: string | null
  last_synced_at: string | null
}

type Props = {
  state: ApolloState
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return date.toLocaleString()
}

export function ApolloCard({ state }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function save() {
    if (!value.trim()) return
    setStatus(null)
    setError(null)
    const apiKey = value.trim()
    startTransition(async () => {
      try {
        const res = await fetch('/api/integrations/apollo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey }),
        })
        const raw: { ok?: boolean; error?: string } = await res
          .json()
          .catch(() => ({}))
        if (!res.ok) {
          setError(raw.error ?? `Save failed (HTTP ${res.status}).`)
          return
        }
        setValue('')
        setEditing(false)
        setStatus('Apollo API key saved.')
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed.')
      }
    })
  }

  function disconnect() {
    setStatus(null)
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch('/api/integrations/apollo', { method: 'DELETE' })
        if (!res.ok) {
          const raw: { error?: string } = await res.json().catch(() => ({}))
          setError(raw.error ?? `Disconnect failed (HTTP ${res.status}).`)
          return
        }
        setStatus('Apollo disconnected.')
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Disconnect failed.')
      }
    })
  }

  return (
    <div className="rounded-2xl aiea-glass p-5 transition-colors hover:border-white/[0.10]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ApolloGlyph />
            <span className="text-sm font-medium text-zinc-100">Apollo.io</span>
            {state.connected ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                Connected
              </span>
            ) : (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Not connected
              </span>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            Enrich contacts with Apollo&apos;s People database — title, company,
            LinkedIn, phone, employment history. Get your API key from{' '}
            <a
              href="https://app.apollo.io/#/settings/integrations/api"
              target="_blank"
              rel="noreferrer"
              className="text-violet-300 underline-offset-2 transition-colors hover:text-violet-200 hover:underline"
            >
              app.apollo.io → Settings → Integrations → API
            </a>
            .
          </p>
          {state.connected && (
            <dl className="mt-4 space-y-1.5 text-xs">
              {state.masked_key && (
                <div className="flex gap-3">
                  <dt className="w-24 shrink-0 text-zinc-500">API key</dt>
                  <dd className="font-mono text-zinc-300">{state.masked_key}</dd>
                </div>
              )}
              <div className="flex gap-3">
                <dt className="w-24 shrink-0 text-zinc-500">Last enrich</dt>
                <dd className="text-zinc-200 tabular-nums">
                  {formatTimestamp(state.last_synced_at)}
                </dd>
              </div>
            </dl>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {!editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(true)
                setStatus(null)
                setError(null)
              }}
              disabled={isPending}
              className="rounded-lg aiea-cta px-4 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.connected ? 'Replace key' : 'Add API key'}
            </button>
          )}
          {state.connected && !editing && (
            <button
              type="button"
              onClick={disconnect}
              disabled={isPending}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-rose-500/50 hover:text-rose-300 disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-4 flex gap-2">
          <input
            type="password"
            autoFocus
            placeholder="Apollo API key"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') {
                setEditing(false)
                setValue('')
              }
            }}
            className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 font-mono text-xs text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
          />
          <button
            type="button"
            onClick={save}
            disabled={isPending || !value.trim()}
            className="rounded-lg aiea-cta px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false)
              setValue('')
            }}
            disabled={isPending}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs text-zinc-400 transition-colors hover:border-white/[0.18] hover:text-zinc-200 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}

      {status && <p className="mt-3 text-xs text-emerald-300">{status}</p>}
      {error && <p className="mt-3 text-xs text-rose-300">{error}</p>}
    </div>
  )
}

function ApolloGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <circle cx="12" cy="12" r="11" fill="#2563eb" />
      <path
        d="M7 16l4-9 1.5 3.5L17 16h-2.5L13 13.5 11.5 16H9.5L11 12.5 9 16H7z"
        fill="#ffffff"
      />
    </svg>
  )
}
