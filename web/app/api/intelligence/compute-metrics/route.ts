import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { computeContactMetricsForUser } from '../../../../lib/intelligence/contact-metrics'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/intelligence/compute-metrics
//
// Recomputes per-contact sentiment_trajectory and reciprocity_ratio for the
// authenticated user (or, in cron mode, for a specified user / all active
// users — same pattern as /api/intelligence/analyze).

type Body = {
  user_id?: unknown
  all_users?: unknown
}

function getCronSecret(): string | null {
  const s = process.env.CRON_SECRET
  return typeof s === 'string' && s.length > 0 ? s : null
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export async function POST(request: Request) {
  let body: Body = {}
  try {
    body = (await request.json()) as Body
  } catch {
    body = {}
  }

  const cronHeader = request.headers.get('x-cron-secret')
  const cronSecret = getCronSecret()
  const isCron =
    cronSecret != null &&
    cronHeader != null &&
    safeEqual(cronHeader, cronSecret)

  const service = getServiceClient()
  if (!service) {
    return apiError(
      500,
      'Service role key not configured',
      undefined,
      'no_service_key',
    )
  }

  if (isCron) {
    if (body.all_users === true) {
      const cutoff = new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000,
      ).toISOString()
      const { data, error } = await service
        .from('events')
        .select('user_id')
        .gte('created_at', cutoff)
      if (error) {
        console.error('[compute-metrics] events query failed', error)
        return apiError(500, 'Failed to enumerate users', undefined, 'query_failed')
      }
      const userIds = [
        ...new Set(
          ((data ?? []) as { user_id: string }[]).map((r) => r.user_id),
        ),
      ]
      const results = []
      for (const uid of userIds) {
        try {
          const run = await computeContactMetricsForUser(service, uid)
          results.push(run)
        } catch (err) {
          results.push({
            user_id: uid,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return NextResponse.json({ ok: true, mode: 'cron_all', results })
    }

    const userId = typeof body.user_id === 'string' ? body.user_id : null
    if (!userId) {
      return apiError(
        400,
        'user_id or all_users is required in cron mode',
        undefined,
        'missing_target',
      )
    }
    const run = await computeContactMetricsForUser(service, userId)
    return NextResponse.json({ ok: true, mode: 'cron_user', run })
  }

  // Authenticated user path.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  try {
    const run = await computeContactMetricsForUser(service, user.id)
    return NextResponse.json({ ok: true, mode: 'user', run })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    console.error('[compute-metrics] failed', err)
    return apiError(500, message, undefined, 'compute_failed')
  }
}
