import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError, apiServerError } from '../../../../lib/api-errors'
import { computeContactScores } from '../../../../lib/intelligence/compute-scores'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/contacts/compute-scores
//
// Auth wrapper around computeContactScores(). The same function runs from
// the daily-sync cron, so there's exactly one scoring implementation; this
// route exists for "recompute now" buttons in the UI and for diagnostics.

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) {
    return apiServerError(
      'contacts.compute-scores.POST',
      new Error('Service role key not configured'),
      'no_service_key',
    )
  }

  try {
    const summary = await computeContactScores(service, user.id)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    return apiServerError('contacts.compute-scores.POST', err, 'compute_failed')
  }
}
