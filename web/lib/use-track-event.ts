'use client'

import { useCallback } from 'react'
import { createClient } from './supabase/client'

// ---------------------------------------------------------------------------
// useTrackEvent — fire analytics events directly into Supabase from the
// browser. Inserts go straight to public.analytics_events via the anon key
// + RLS (auth.uid() = user_id). Fire-and-forget; failures are logged and
// swallowed so a tracker error never breaks the UI.
//
// Usage:
//   const track = useTrackEvent()
//   track('button_click', { button: 'add_contact' })
//   track('sync_trigger', { source: 'gmail' })
//
// Page views and global error listeners are wired up by AnalyticsTracker.
// ---------------------------------------------------------------------------

export type TrackEventFn = (
  eventName: string,
  metadata?: Record<string, unknown>,
) => void

export function useTrackEvent(): TrackEventFn {
  return useCallback((eventName, metadata) => {
    void fireEvent(eventName, metadata)
  }, [])
}

export async function fireEvent(
  eventName: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const supabase = createClient()
    // getSession() reads from local storage — no /auth/v1/user round-trip.
    // The page-view + delegated click listeners can fire dozens of these
    // per minute on a noisy page, so the per-request network cost adds up.
    // RLS (auth.uid() = user_id) still rejects the insert if the JWT is
    // invalid, so the pre-check is purely there to skip the insert when
    // the user is signed out (saves the round-trip and a 401).
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const userId = session?.user?.id
    if (!userId) return
    const { error } = await supabase.from('analytics_events').insert({
      user_id: userId,
      event_name: eventName,
      metadata: metadata ?? {},
    })
    if (error) {
      console.warn('[track-event] insert failed:', error.message)
    }
  } catch (err) {
    console.warn('[track-event] threw:', err)
  }
}
