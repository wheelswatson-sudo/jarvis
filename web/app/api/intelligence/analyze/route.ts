import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { runEngineForUser } from '../../../../lib/intelligence/experience-engine'
import { generateInsightsForUser } from '../../../../lib/intelligence/insight-generator'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/intelligence/analyze
//
// Two modes of invocation:
//
//   1. Authenticated user — body { user_id?: string } is ignored, the
//      caller's id is always used.
//   2. Cron / service — header `x-cron-secret: $CRON_SECRET` and a body of
//      either { user_id: 'uuid' } for a single user, or
//      { all_users: true } to fan out across every user with recent events.
//
// The cron mode uses the Supabase service-role key so it can read across
// users. The authenticated mode uses the per-request server client so RLS
// is enforced as usual.

type AnalyzeBody = {
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
  let body: AnalyzeBody = {}
  try {
    body = (await request.json()) as AnalyzeBody
  } catch {
    body = {}
  }

  const cronHeader = request.headers.get('x-cron-secret')
  const cronSecret = getCronSecret()
  const isCron =
    cronSecret != null && cronHeader != null && safeEqual(cronHeader, cronSecret)

  // -- Cron path ---------------------------------------------------------
  if (isCron) {
    const service = getServiceClient()
    if (!service) {
      return apiError(
        500,
        'Service role key not configured',
        undefined,
        'no_service_key',
      )
    }

    if (body.all_users === true) {
      // Pull every user_id with at least one event in the last 30 days.
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data, error } = await service
        .from('events')
        .select('user_id')
        .gte('created_at', cutoff)
      if (error) {
        console.error('[analyze] events query failed', error)
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
          const engineRun = await runEngineForUser(service, uid)
          const generatorRun = await generateInsightsForUser(service, uid)
          results.push({ user_id: uid, engineRun, generatorRun })
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
    const engineRun = await runEngineForUser(service, userId)
    const generatorRun = await generateInsightsForUser(service, userId)
    return NextResponse.json({
      ok: true,
      mode: 'cron_user',
      engineRun,
      generatorRun,
    })
  }

  // -- Authenticated user path -------------------------------------------
  // Auth comes from the cookie-bound session client; writes go through the
  // service-role client because the intelligence tables have no user-side
  // INSERT/UPDATE policies. The engine functions scope every query by
  // user.id internally.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const service = getServiceClient()
  if (!service) {
    return apiError(
      500,
      'Service role key not configured',
      undefined,
      'no_service_key',
    )
  }

  try {
    const engineRun = await runEngineForUser(service, user.id)
    const generatorRun = await generateInsightsForUser(service, user.id)
    return NextResponse.json({
      ok: true,
      mode: 'user',
      engineRun,
      generatorRun,
    })
  } catch (err) {
    console.error('[analyze] user-path engine failed', err)
    return apiError(500, 'Intelligence engine failed', undefined, 'engine_failed')
  }
}
