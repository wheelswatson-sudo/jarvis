'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { fireEvent } from '../lib/use-track-event'

// Mounted once at the app layout level. Wires up:
//   - page_view on every pathname change (and the initial mount)
//   - global window error + unhandledrejection -> error event
//   - delegated [data-track-click] click handler so any button can opt-in
//     to click tracking by adding the attribute (with optional
//     data-track-meta='{"key":"value"}' JSON for extra metadata).
//   - sync_trigger when a button with data-sync-source="..." is clicked.

export function AnalyticsTracker() {
  const pathname = usePathname()
  const lastPath = useRef<string | null>(null)

  useEffect(() => {
    if (lastPath.current === pathname) return
    lastPath.current = pathname
    void fireEvent('page_view', { path: pathname })
  }, [pathname])

  useEffect(() => {
    function onError(e: ErrorEvent) {
      void fireEvent('error', {
        message: e.message,
        source: e.filename,
        line: e.lineno,
        column: e.colno,
      })
    }
    function onRejection(e: PromiseRejectionEvent) {
      void fireEvent('error', {
        message: String(e.reason?.message ?? e.reason ?? 'unhandled rejection'),
        kind: 'unhandledrejection',
      })
    }
    function onClick(e: MouseEvent) {
      const target = e.target
      if (!(target instanceof Element)) return
      const trackEl = target.closest<HTMLElement>('[data-track-click]')
      if (trackEl) {
        const label = trackEl.dataset.trackClick || 'unknown'
        let extra: Record<string, unknown> = {}
        if (trackEl.dataset.trackMeta) {
          try {
            extra = JSON.parse(trackEl.dataset.trackMeta)
          } catch {
            // Ignore malformed metadata — never let tracking break clicks.
          }
        }
        void fireEvent('button_click', { label, ...extra })
      }
      const syncEl = target.closest<HTMLElement>('[data-sync-source]')
      if (syncEl) {
        void fireEvent('sync_trigger', {
          source: syncEl.dataset.syncSource,
        })
      }
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    document.addEventListener('click', onClick, { capture: true })
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      document.removeEventListener('click', onClick, { capture: true })
    }
  }, [])

  return null
}
