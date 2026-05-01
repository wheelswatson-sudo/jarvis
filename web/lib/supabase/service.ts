import { createClient as createSupabaseClient } from '@supabase/supabase-js'

// Service-role client — bypasses RLS. The intelligence tables
// (experience_capsules, intelligence_insights) only have user-side SELECT
// policies; all INSERT/UPDATE goes through this client. Callers MUST
// authenticate the user separately via the cookie-based server client and
// scope every query to the authenticated user_id for defense-in-depth.
//
// Returns null if SUPABASE_SERVICE_ROLE_KEY isn't configured so callers can
// surface a 500 instead of crashing at module load.
export function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
