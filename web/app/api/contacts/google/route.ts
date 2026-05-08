import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { getValidAccessTokenForUser } from '../../../../lib/google/oauth'
import { syncGoogleContactsForUser } from '../../../../lib/google/contacts-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST — sync Google Contacts using the access token from the Supabase
// session (granted at login via the contacts.readonly scope). The actual
// People API + DB merge logic lives in lib/google/contacts-sync so it can
// be called both from here and from the auto-sync fan-out.
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error

  const service = getServiceClient()
  if (!service) {
    return apiError(
      500,
      'Service role key not configured.',
      undefined,
      'service_unavailable',
    )
  }

  const outcome = await syncGoogleContactsForUser(service, user.id, tok.token)
  if (!outcome.ok) {
    return apiError(
      outcome.error.status,
      outcome.error.message,
      outcome.error.partial,
      outcome.error.code,
    )
  }

  const { inserted, updated, skipped, total_fetched } = outcome.result
  return NextResponse.json({ inserted, updated, skipped, total_fetched })
}
