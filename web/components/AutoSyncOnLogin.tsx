'use client'

import { useEffect, useState } from 'react'

type ServiceState =
  | { ok: true; skipped?: false; counts?: Record<string, number | null> }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; error: string }

type AutoSyncResponse = {
  ok: true
  throttled: boolean
  account_email: string | null
  services: {
    gmail: ServiceState
    calendar: ServiceState
    tasks: ServiceState
    contacts: ServiceState
  }
}

// One-shot session-scoped flag. sessionStorage is per-tab and cleared on
// close, which matches "fire on first authenticated page load per session"
// without any server bookkeeping. The /api/google/auto-sync route layers a
// 5-minute server-side throttle on top of this for cross-tab cases.
const SESSION_KEY = 'aiea:auto-sync-fired-v1'

type Status = 'idle' | 'syncing' | 'done' | 'error' | 'reconnect'

// Auto-sync trigger mounted in the (app) layout. On first mount per session,
// POSTs to /api/google/auto-sync (which fans out Gmail / Calendar / Tasks /
// Contacts in parallel). Renders a small toast in the corner that fades out
// once everything's done. If Google isn't connected, the toast disappears
// silently.
export function AutoSyncOnLogin() {
  const [status, setStatus] = useState<Status>('idle')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem(SESSION_KEY) === '1') return
    sessionStorage.setItem(SESSION_KEY, '1')

    const controller = new AbortController()
    let cancelled = false

    void (async () => {
      // setState lives inside the async IIFE so the lint rule against
      // "synchronous setState in effect body" stays happy — the
      // microtask boundary defers these out of the effect's sync phase.
      if (cancelled) return
      setStatus('syncing')
      setVisible(true)
      try {
        const res = await fetch('/api/google/auto-sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store',
          signal: controller.signal,
        })
        if (cancelled) return

        if (res.status === 401) {
          // Not signed in yet — drop the flag so a real login retries.
          sessionStorage.removeItem(SESSION_KEY)
          setStatus('idle')
          setVisible(false)
          return
        }

        if (!res.ok) {
          setStatus('error')
          return
        }
        const data = (await res.json().catch(() => null)) as
          | AutoSyncResponse
          | null
        if (!data) {
          setStatus('error')
          return
        }

        const services = data.services
        const skipReasons = (Object.values(services) as ServiceState[])
          .map((s) => ('skipped' in s && s.skipped ? s.reason : null))
          .filter((r): r is string => r !== null)
        const allSkipped = skipReasons.length === 4

        // Revoked-grant case: Google returned invalid_grant for the
        // refresh token. Silently hiding the toast here lets the user's
        // sync stay broken for weeks before they notice — surface it.
        if (allSkipped && skipReasons.every((r) => r === 'reconnect_required')) {
          setStatus('reconnect')
          return
        }

        if (allSkipped) {
          // not_connected (user never linked Google), recently_synced
          // (another tab already ran), or transient (logged server-side):
          // hide the toast silently — none of these are actionable here.
          setVisible(false)
          return
        }
        setStatus('done')
      } catch (err) {
        if (cancelled) return
        // AbortError fires when the component unmounts mid-flight; that's
        // not a real failure, so we don't surface it.
        if (err instanceof DOMException && err.name === 'AbortError') return
        setStatus('error')
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  // Auto-dismiss on success after a beat. Errors stick around so the user
  // can see them; they can click to dismiss.
  useEffect(() => {
    if (status !== 'done') return
    const t = setTimeout(() => setVisible(false), 2400)
    return () => clearTimeout(t)
  }, [status])

  if (!visible) return null

  const label =
    status === 'syncing'
      ? 'Syncing your Google data…'
      : status === 'done'
        ? 'All synced'
        : status === 'reconnect'
          ? 'Google connection expired — reconnect in Settings'
          : status === 'error'
            ? 'Sync had issues — check Settings'
            : ''
  if (!label) return null

  const tone =
    status === 'syncing'
      ? 'border-violet-500/30 bg-violet-500/[0.10] text-violet-100'
      : status === 'done'
        ? 'border-emerald-500/30 bg-emerald-500/[0.10] text-emerald-100'
        : status === 'reconnect'
          ? 'border-amber-500/30 bg-amber-500/[0.10] text-amber-100'
          : 'border-rose-500/30 bg-rose-500/[0.10] text-rose-100'

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={() => setVisible(false)}
      className={`fixed bottom-4 left-4 z-40 flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-lg backdrop-blur-md transition-opacity ${tone}`}
    >
      {status === 'syncing' && (
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-current"
        />
      )}
      {status === 'done' && (
        <span aria-hidden="true">✓</span>
      )}
      <span>{label}</span>
    </div>
  )
}
