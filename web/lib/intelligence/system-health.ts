import type { SupabaseClient } from '@supabase/supabase-js'
import type { SystemHealthEventType } from '../types'

// Wrapper around system_health_log inserts. Always fire-and-forget — if the
// log write fails, the calling analysis continues.

export type SystemEventInput = {
  event_type: SystemHealthEventType
  user_id?: string | null
  details?: Record<string, unknown>
}

export async function logSystemEvent(
  supabase: SupabaseClient,
  input: SystemEventInput,
): Promise<void> {
  try {
    const { error } = await supabase.from('system_health_log').insert({
      event_type: input.event_type,
      user_id: input.user_id ?? null,
      details: input.details ?? {},
    })
    if (error) {
      console.warn('[system_health] insert failed:', error.message)
    }
  } catch (err) {
    console.warn(
      '[system_health] insert threw:',
      err instanceof Error ? err.message : err,
    )
  }
}
