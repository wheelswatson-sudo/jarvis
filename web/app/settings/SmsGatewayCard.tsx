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
const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=app.sms_gate'
const SMS_GATEWAY_DOCS = 'https://docs.sms-gate.app/'

export function SmsGatewayCard({ state, webhook_url, user_id }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const [gatewayUrl, setGatewayUrl] = useState(state.gateway_url ?? DEFAULT_GATEWAY_URL)
  const [username, setUsername] = useState(state.username ?? 'sms')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [webhookCopied, setWebhookCopied] = useState(false)

  const fullWebhookUrl = `${webhook_url}?user_id=${user_id}`

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

  function testConnection() {
    setStatus(null)
    setError(null)
    startTransition(async () => {
      try {
        setStatus('Testing connection…')
        const res = await fetch('/api/integrations/sms-gateway/test', {
          method: 'POST',
        })
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          sample_count?: number
          error?: string
        }
        if (!res.ok || !data.ok) {
          setError(data.error ?? `Connection failed (HTTP ${res.status}).`)
          setStatus(null)
          return
        }
        setStatus(
          `Gateway reachable. ${data.sample_count ?? 0} message${
            data.sample_count === 1 ? '' : 's'
          } available.`,
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Connection test failed.')
        setStatus(null)
      }
    })
  }

  async function copyWebhook() {
    try {
      await navigator.clipboard.writeText(fullWebhookUrl)
      setWebhookCopied(true)
      setTimeout(() => setWebhookCopied(false), 2000)
    } catch {
      // Older browsers / locked-down WebViews — surface as inline error.
      setError('Could not copy. Long-press the URL to copy manually.')
    }
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
              <span className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                Not connected
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Sync texts from your Android phone so SMS lands in your unified
            inbox alongside email, matched to contacts by phone number.
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
              className="rounded-lg aiea-cta px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              {isPending ? 'Working…' : 'Sync now'}
            </button>
          )}
          {state.connected && !editing && (
            <button
              type="button"
              onClick={testConnection}
              disabled={isPending}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-50"
            >
              Test connection
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
                  ? 'rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-violet-400/50 hover:text-violet-200 disabled:opacity-50'
                  : 'rounded-lg aiea-cta px-4 py-2 text-xs font-medium text-white disabled:opacity-50'
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
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-rose-500/50 hover:text-rose-300 disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {!state.connected && !editing && (
        <ol className="mt-4 space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-xs text-zinc-400">
          <li className="flex gap-3">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-violet-500/20 text-[10px] font-semibold text-violet-200 ring-1 ring-inset ring-violet-500/30">
              1
            </span>
            <div className="min-w-0">
              <div className="font-medium text-zinc-200">
                Install the SMS Gateway app on your Android phone
              </div>
              <div className="mt-0.5">
                <a
                  href={PLAY_STORE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-violet-300 hover:text-violet-200 hover:underline"
                >
                  Open in Play Store ↗
                </a>
              </div>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-violet-500/20 text-[10px] font-semibold text-violet-200 ring-1 ring-inset ring-violet-500/30">
              2
            </span>
            <div className="min-w-0">
              <div className="font-medium text-zinc-200">
                Enable Cloud mode and copy the generated credentials
              </div>
              <div className="mt-0.5">
                In the app: <span className="text-zinc-300">Settings → Cloud server</span>{' '}
                → toggle on. The app shows a username (default{' '}
                <code className="rounded bg-white/[0.04] px-1 text-zinc-300">sms</code>) and password.
              </div>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-violet-500/20 text-[10px] font-semibold text-violet-200 ring-1 ring-inset ring-violet-500/30">
              3
            </span>
            <div className="min-w-0">
              <div className="font-medium text-zinc-200">
                Click Connect below and paste the credentials
              </div>
              <div className="mt-0.5">
                Then test the connection and configure the webhook for
                real-time push.{' '}
                <a
                  href={SMS_GATEWAY_DOCS}
                  target="_blank"
                  rel="noreferrer"
                  className="text-violet-300 hover:text-violet-200 hover:underline"
                >
                  Full docs ↗
                </a>
              </div>
            </div>
          </li>
        </ol>
      )}

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
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 font-mono text-xs text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
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
                className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 font-mono text-xs text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
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
                className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 font-mono text-xs text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={isPending || !apiKey.trim() || !gatewayUrl.trim()}
              className="rounded-lg aiea-cta px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
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
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs text-zinc-400 transition-colors hover:border-white/[0.18] hover:text-zinc-200 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          Webhook (real-time push)
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">
          Paste this URL into the SMS Gateway app under{' '}
          <span className="text-zinc-300">Webhooks → Add webhook</span> so new
          messages stream in immediately.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2 font-mono text-[11px] text-zinc-300">
            {fullWebhookUrl}
          </code>
          <button
            type="button"
            onClick={copyWebhook}
            className="shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs text-zinc-200 transition-colors hover:border-violet-400/50 hover:text-violet-200"
          >
            {webhookCopied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <details className="mt-3 text-[11px] text-zinc-500">
          <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
            Webhook header & events
          </summary>
          <dl className="mt-2 space-y-1.5">
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
          <p className="pt-2 text-zinc-500">
            The shared secret must match the{' '}
            <code className="text-zinc-300">SMS_GATEWAY_WEBHOOK_SECRET</code>{' '}
            env var on the server. Without it, every webhook request is
            rejected with 401.
          </p>
        </details>
      </div>

      {status && <p className="mt-3 text-xs text-emerald-300">{status}</p>}
      {error && <p className="mt-3 text-xs text-rose-300">{error}</p>}
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
