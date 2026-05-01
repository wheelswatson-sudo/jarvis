import { createClient as createServerSupabase } from './supabase/server'
import type { EventType } from './types'

// ---------------------------------------------------------------------------
// Server-side event tracking
//
// Fire-and-forget: callers should NOT await this in a way that blocks the
// response — the calling code can either ignore the promise or await it
// inside an after()/waitUntil-style background hook. We swallow all errors
// so the intelligence system can never break the user-facing flow.
// ---------------------------------------------------------------------------

export type TrackEventInput = {
  userId: string
  eventType: EventType
  contactId?: string | null
  metadata?: Record<string, unknown>
}

export async function trackEvent(input: TrackEventInput): Promise<void> {
  try {
    const supabase = await createServerSupabase()
    const { error } = await supabase.from('events').insert({
      user_id: input.userId,
      event_type: input.eventType,
      contact_id: input.contactId ?? null,
      metadata: input.metadata ?? {},
    })
    if (error) {
      console.warn('[events] insert failed:', error.message)
    }
  } catch (err) {
    console.warn(
      '[events] insert threw:',
      err instanceof Error ? err.message : err,
    )
  }
}

// Convenience wrappers — keep the call sites tidy and the event_type
// strings centralized.

export const trackContactView = (
  userId: string,
  contactId: string,
  metadata?: Record<string, unknown>,
) => trackEvent({ userId, eventType: 'contact_viewed', contactId, metadata })

export const trackContactUpdate = (
  userId: string,
  contactId: string,
  metadata?: Record<string, unknown>,
) => trackEvent({ userId, eventType: 'contact_updated', contactId, metadata })

export const trackOutreach = (
  userId: string,
  contactId: string | null,
  metadata?: Record<string, unknown>,
) => trackEvent({ userId, eventType: 'outreach_sent', contactId, metadata })

export const trackCommitmentCreate = (
  userId: string,
  contactId: string | null,
  metadata?: Record<string, unknown>,
) =>
  trackEvent({ userId, eventType: 'commitment_created', contactId, metadata })

export const trackCommitmentComplete = (
  userId: string,
  contactId: string | null,
  metadata?: Record<string, unknown>,
) =>
  trackEvent({
    userId,
    eventType: 'commitment_completed',
    contactId,
    metadata,
  })

export const trackCommitmentMissed = (
  userId: string,
  contactId: string | null,
  metadata?: Record<string, unknown>,
) =>
  trackEvent({ userId, eventType: 'commitment_missed', contactId, metadata })

export const trackImport = (
  userId: string,
  metadata?: Record<string, unknown>,
) => trackEvent({ userId, eventType: 'import_completed', metadata })

export const trackChatQuery = (
  userId: string,
  metadata?: Record<string, unknown>,
) => trackEvent({ userId, eventType: 'chat_query', metadata })

export const trackInsightActedOn = (
  userId: string,
  metadata?: Record<string, unknown>,
) => trackEvent({ userId, eventType: 'insight_acted_on', metadata })

export const trackInsightDismissed = (
  userId: string,
  metadata?: Record<string, unknown>,
) => trackEvent({ userId, eventType: 'insight_dismissed', metadata })
