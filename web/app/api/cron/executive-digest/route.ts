import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { buildExecutiveDigest } from '../../../../lib/intelligence/executive-digest'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// GET /api/cron/executive-digest
//
// Vercel cron — Fridays only via the schedule in vercel.json. Generates
// one executive digest per connected user and upserts on (user_id,
// week_starting). Manual kicks for backfill or recovery:
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://aiea.app/api/cron/executive-digest
//
// Auth matches /api/cron/daily-sync: header-only Bearer compared in
// constant time.
export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return apiError(
      500,
      'CRON_SECRET is not configured.',
      undefined,
      'no_cron_secret',
    )
  }

  const auth = req.headers.get('authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  if (!bearer || !safeEqual(bearer, expected)) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const service = getServiceClient()
  if (!service) {
    return apiError(
      500,
      'Service role key not configured.',
      undefined,
      'no_service_key',
    )
  }

  const { data: integrations, error: integErr } = await service
    .from('user_integrations')
    .select('user_id, account_email')
    .eq('provider', 'google')
    .not('refresh_token', 'is', null)

  if (integErr) {
    return apiError(
      500,
      `Failed to list integrations: ${integErr.message}`,
      undefined,
      'integrations_query_failed',
    )
  }

  type Row = { user_id: string; account_email: string | null }
  const users = (integrations ?? []) as Row[]

  const results: Array<{
    user_id: string
    ok: boolean
    week_starting?: string
    error?: string
  }> = []

  for (const u of users) {
    try {
      const userName = u.account_email
        ? u.account_email.split('@')[0] ?? 'me'
        : 'me'
      const digest = await buildExecutiveDigest({
        service,
        userId: u.user_id,
        userName,
      })
      const { error: upsertErr } = await service
        .from('executive_digests')
        .upsert(
          {
            user_id: u.user_id,
            week_starting: digest.payload.week_starting,
            payload: digest.payload,
            markdown: digest.markdown,
            model: digest.payload.model,
            generated_at: digest.payload.generated_at,
          },
          { onConflict: 'user_id,week_starting' },
        )
      results.push({
        user_id: u.user_id,
        ok: !upsertErr,
        week_starting: digest.payload.week_starting,
        error: upsertErr?.message,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      console.error('[cron executive-digest] user failed', {
        user_id: u.user_id,
        message,
      })
      results.push({ user_id: u.user_id, ok: false, error: message })
    }
  }

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    ran_at: new Date().toISOString(),
    user_count: users.length,
    results,
  })
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
