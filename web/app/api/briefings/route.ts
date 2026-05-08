import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import { apiError } from '../../../lib/api-errors'
import {
  loadBriefingById,
  loadBriefings,
} from '../../../lib/contacts/meeting-briefings'

export const dynamic = 'force-dynamic'

// GET /api/briefings
//   ?id=<event_id>     — single briefing for one calendar_event
//   ?windowHours=48    — how far ahead to scan (default 48, max 168)
//   ?limit=25          — max events to return (default 25, max 100)
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const url = new URL(req.url)
  const id = url.searchParams.get('id')

  if (id) {
    const briefing = await loadBriefingById(supabase, user.id, id)
    if (!briefing) {
      return apiError(404, 'Briefing not found', undefined, 'not_found')
    }
    return NextResponse.json({ briefing })
  }

  const windowHoursRaw = Number(url.searchParams.get('windowHours'))
  const limitRaw = Number(url.searchParams.get('limit'))
  const windowHours =
    Number.isFinite(windowHoursRaw) && windowHoursRaw > 0
      ? Math.min(windowHoursRaw, 168)
      : 48
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 25

  const result = await loadBriefings(supabase, user.id, {
    windowHours,
    limit,
  })
  return NextResponse.json(result)
}
