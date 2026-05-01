'use client'

import { useEventTracker } from '../lib/events-client'
import type { EventType } from '../lib/types'

// Thin client-side wrapper to fire a single event on mount. Used to record
// page views from inside server components without converting the whole page
// to a client component.

export function PageViewTracker({
  eventType,
  contactId,
  metadata,
}: {
  eventType: EventType
  contactId?: string | null
  metadata?: Record<string, unknown>
}) {
  useEventTracker({ eventType, contactId, metadata })
  return null
}
