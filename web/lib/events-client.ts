'use client'

import { useEffect, useRef } from 'react'
import type { EventType } from './types'

// ---------------------------------------------------------------------------
// Client-side event tracking
//
// The browser hits POST /api/intelligence/events. Fire-and-forget — failures
// are logged and swallowed. Use sendBeacon when available so the request
// survives page navigations.
// ---------------------------------------------------------------------------

export type ClientEventInput = {
  eventType: EventType
  contactId?: string | null
  metadata?: Record<string, unknown>
}

export function trackEventClient(input: ClientEventInput): void {
  if (typeof window === 'undefined') return
  const body = JSON.stringify({
    event_type: input.eventType,
    contact_id: input.contactId ?? null,
    metadata: input.metadata ?? {},
  })

  try {
    if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
      const blob = new Blob([body], { type: 'application/json' })
      const ok = navigator.sendBeacon('/api/intelligence/events', blob)
      if (ok) return
    }
    void fetch('/api/intelligence/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch((err) => {
      console.warn('[events-client] POST failed:', err)
    })
  } catch (err) {
    console.warn('[events-client] threw:', err)
  }
}

// Hook — auto-tracks a single mount as the named event. Useful for page-view
// style tracking where you want to fire once per visit. Pass a contactId to
// scope the event to a specific contact.
export function useEventTracker(input: ClientEventInput): void {
  const fired = useRef(false)
  const stableKey = `${input.eventType}:${input.contactId ?? ''}:${JSON.stringify(input.metadata ?? {})}`

  useEffect(() => {
    if (fired.current) return
    fired.current = true
    trackEventClient(input)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableKey])
}
