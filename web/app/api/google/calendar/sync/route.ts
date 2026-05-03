import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'
import { getServiceClient } from '../../../../../lib/supabase/service'
import { apiError } from '../../../../../lib/api-errors'
import {
  getValidAccessTokenForUser,
  googleApiError,
} from '../../../../../lib/google/oauth'
import { syncCalendarForUser } from '../../../../../lib/google/calendar-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PROVIDER = 'google_calendar'

// POST /api/google/calendar/sync
//
// Pulls upcoming calendar events for the authenticated user using the
// persisted Google access token (silent refresh) and upserts them into
// `calendar_events`. Body is optional:
//   { past_days?: number, future_days?: number, calendar_id?: string }
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service key not configured', undefined, 'no_service_key')
  }

  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error

  const body = (await req.json().catch(() => null)) as
    | { past_days?: number; future_days?: number; calendar_id?: string }
    | null

  let result
  try {
    result = await syncCalendarForUser(service, user.id, tok.token, {
      pastDays: body?.past_days,
      futureDays: body?.future_days,
      calendarId: body?.calendar_id,
    })
  } catch (err) {
    return googleApiError(err)
  }

  await service.from('user_integrations').upsert(
    {
      user_id: user.id,
      provider: PROVIDER,
      last_synced_at: new Date().toISOString(),
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events',
      ],
    },
    { onConflict: 'user_id,provider' },
  )

  return NextResponse.json({ ok: true, ...result })
}
