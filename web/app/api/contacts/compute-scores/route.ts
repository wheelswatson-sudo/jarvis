import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
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
    return apiError(500, 'Service role key not configured', undefined, 'no_service_key')
  }

  try {
    const summary = await computeContactScores(service, user.id)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    console.error('[compute-scores] failed', err)
    return apiError(
      500,
      err instanceof Error ? err.message : 'Compute failed',
      undefined,
      'compute_failed',
    )
  }
}
