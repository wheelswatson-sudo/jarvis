'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export type SmsGatewayState = {
  connected: boolean
  gateway_url: string | null
  username: string | null
  masked_key: string | null
  last_synced_at: string | null
  last_message_at: string | null
}

type Props = {
  state: SmsGatewayState
  webhook_url: string
  user_id: string
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleString()
}

const DEFAULT_GATEWAY_URL = 'https://api.sms-gate.app/3rdparty/v1'

export function SmsGatewayCard({ state, webhook_url, user_id }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const [gatewayUrl, setGatewayUrl] = useState(state.gateway_url ?? DEFAULT_GATEWAY_URL)
  const [username, setUsername] = useState(state.username ?? 'sms')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showWebhook, setShowWebhook] = useState(false)

  function save() {
    if (!apiKey.trim() || !gatewayUrl.trim()) return
    setStatus(null)
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch('/api/integrations/sms-gateway', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gateway_url: gatewayUrl.trim(),
            username: username.trim() || 'sms',
            api_key: apiKey.trim(),
          }),
        })
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) {
          setError(data.error ?? `Save failed (HTTP ${res.status}).`)
          return
        }
        setApiKey('')
        setEditing(false)
        setStatus('SMS gateway connected.')
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
        const res = await fetch('/api/integrations/sms-gateway', { method: 'DELETE' })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          setError(data.error ?? `Disconnect failed (HTTP ${res.status}).`)
          return
        }
        setStatus('SMS gateway disconnected.')
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Disconnect failed.')
      }
    })
  }

  function syncNow() {
    setStatus(null)
    setError(null)
    startTransition(async () => {
      try {
        setStatus('Pulling messages from gateway…')
        const res = await fetch('/api/sms/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 200 }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          fetched?: number
          imported?: number
          skipped?: number
          errors?: number
          unmatched_contact?: number
          sample_skip_reasons?: string[]
          error?: string
        }
        if (!res.ok) {
          setError(data.error ?? `Sync failed (HTTP ${res.status}).`)
          setStatus(null)
          return
        }
        const fetched = data.fetched ?? 0
        const imported = data.imported ?? 0
        const skipped = data.skipped ?? 0
        const errors = data.errors ?? 0
        const unmatched = data.unmatched_contact ?? 0
        const reasonSummary =
          skipped > 0 && data.sample_skip_reasons?.length
            ? ` (${data.sample_skip_reasons.join(', ')})`
            : ''
        setStatus(
          fetched === 0
            ? 'No messages on the gateway yet.'
            : `Fetched ${fetched} · ${imported} new · ${skipped} skipped${reasonSummary}` +
                (unmatched ? ` · ${unmatched} not matched to a contact` : '') +
                (errors ? ` · ${errors} errors.` : '.'),
        )
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sync failed.')
        setStatus(null)
      }
    })
  }

  return (
    <div className="rounded-2xl aiea-glass p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SmsGlyph />
            <span className="text-sm font-medium text-zinc-100">SMS Gateway (Android)</span>
            {state.connected ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                Connected
              </span>
            ) : (
              <span className="rounded-full border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                Not connected
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Sync texts from your Android phone via the{' '}
            <a
              href="https://docs.sms-gate.app/"
              target="_blank"
              rel="noreferrer"
              className="text-violet-400 hover:underline"
            >
              SMS Gateway for Android
            </a>{' '}
            app. Inbound and outbound SMS land in the unified messages
            table, matched to existing contacts by phone number.
          </p>
          {state.connected && (
            <dl className="mt-3 space-y-1 text-xs text-zinc-400">
              {state.gateway_url && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-zinc-500">Gateway</dt>
                  <dd className="truncate font-mono text-zinc-300">
                    {state.gateway_url}
                  </dd>
                </div>
              )}
              {state.masked_key && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-zinc-500">API key</dt>
                  <dd className="font-mono text-zinc-300">{state.masked_key}</dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-zinc-500">Last sync</dt>
                <dd className="text-zinc-300">{formatTimestamp(state.last_synced_at)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-zinc-500">Last message</dt>
                <dd className="text-zinc-300">{formatTimestamp(state.last_message_at)}</dd>
              </div>
            </dl>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {state.connected && !editing && (
            <button
              type="button"
              onClick={syncNow}
              disabled={isPending}
              className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-indigo-500/30 hover:from-indigo-400 hover:to-violet-400 disabled:opacity-50 transition-all"
            >
              {isPending ? 'Syncing…' : 'Sync now'}
            </button>
          )}
          {!editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(true)
                setStatus(null)
                setError(null)
              }}
              disabled={isPending}
              className={
                state.connected
                  ? 'rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:border-indigo-500 hover:text-indigo-300 disabled:opacity-50 transition-colors'
                  : 'rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-indigo-500/30 hover:from-indigo-400 hover:to-violet-400 disabled:opacity-50 transition-all'
              }
            >
              {state.connected ? 'Reconfigure' : 'Connect'}
            </button>
          )}
          {state.connected && !editing && (
            <button
              type="button"
              onClick={disconnect}
              disabled={isPending}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-50 transition-colors"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-zinc-500">
              Gateway base URL
            </label>
            <input
              type="text"
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              placeholder={DEFAULT_GATEWAY_URL}
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
            />
            <p className="mt-1 text-[11px] text-zinc-500">
              Cloud mode default:{' '}
              <code className="text-zinc-300">{DEFAULT_GATEWAY_URL}</code>. For
              local mode, use your phone&rsquo;s LAN URL like{' '}
              <code className="text-zinc-300">http://192.168.1.42:8080</code>.
            </p>
          </div>
          <div className="flex gap-2">
            <div className="w-28 shrink-0">
              <label className="block text-[10px] uppercase tracking-wide text-zinc-500">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="sms"
                className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[10px] uppercase tracking-wide text-zinc-500">
                API key (password)
              </label>
              <input
                type="password"
                autoFocus
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') save()
                  if (e.key === 'Escape') {
                    setEditing(false)
                    setApiKey('')
                  }
                }}
                placeholder="Generated by the gateway app"
                className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={isPending || !apiKey.trim() || !gatewayUrl.trim()}
              className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 px-4 py-2 text-xs font-medium text-white shadow-sm shadow-indigo-500/30 hover:from-indigo-400 hover:to-violet-400 disabled:opacity-50 transition-all"
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setApiKey('')
              }}
              disabled={isPending}
              className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
        <button
          type="button"
          onClick={() => setShowWebhook((s) => !s)}
          className="flex w-full items-center justify-between text-left text-xs text-zinc-400 hover:text-zinc-200"
        >
          <span className="font-medium">
            {showWebhook ? 'Hide' : 'Show'} webhook setup (real-time push)
          </span>
          <span aria-hidden>{showWebhook ? '▾' : '▸'}</span>
        </button>
        {showWebhook && (
          <div className="mt-3 space-y-2 text-[11px] text-zinc-500">
            <p>
              In the SMS Gateway app, add a webhook with these settings so new
              messages stream into AIEA in real time:
            </p>
            <dl className="space-y-1">
              <div className="flex flex-col gap-1">
                <dt className="text-zinc-500">URL</dt>
                <dd className="font-mono text-zinc-300 break-all">
                  {webhook_url}?user_id={user_id}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-zinc-500">Header</dt>
                <dd className="font-mono text-zinc-300">
                  Authorization: Bearer &lt;SMS_GATEWAY_WEBHOOK_SECRET&gt;
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-zinc-500">Events</dt>
                <dd className="font-mono text-zinc-300">
                  sms:received, sms:sent, sms:delivered
                </dd>
              </div>
            </dl>
            <p className="pt-1 text-zinc-500">
              The shared secret must match the{' '}
              <code className="text-zinc-300">SMS_GATEWAY_WEBHOOK_SECRET</code>{' '}
              env var on the server. Without it, every webhook request is
              rejected with 401.
            </p>
          </div>
        )}
      </div>

      {status && <p className="mt-3 text-xs text-emerald-400">{status}</p>}
      {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}
    </div>
  )
}

function SmsGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        fill="url(#sms-grad)"
        d="M4 4h16a2 2 0 012 2v10a2 2 0 01-2 2H8l-4 4V6a2 2 0 012-2z"
      />
      <defs>
        <linearGradient id="sms-grad" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
    </svg>
  )
}
