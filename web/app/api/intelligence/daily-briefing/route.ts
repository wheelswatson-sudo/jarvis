import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError, apiServerError } from '../../../../lib/api-errors'
import { buildDailyBriefing } from '../../../../lib/intelligence/daily-briefing'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET — return the most recent cached briefing for the authenticated user.
export async function GET() {
  const supabase = await createClient()
  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'] =
    null
  try {
    const { data } = await supabase.auth.getUser()
    user = data.user
  } catch (err) {
    console.error('[daily-briefing] getUser threw', err)
  }
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const { data, error } = await supabase
    .from('daily_briefings')
    .select('*')
    .eq('user_id', user.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    return apiServerError('intelligence.daily-briefing.GET', error, 'query_failed')
  }
  return NextResponse.json({ briefing: data ?? null })
}

// POST — generate a new briefing, persist it, and return it.
export async function POST() {
  const supabase = await createClient()
  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'] =
    null
  try {
    const { data } = await supabase.auth.getUser()
    user = data.user
  } catch (err) {
    console.error('[daily-briefing] getUser threw', err)
  }
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) {
    return apiServerError(
      'intelligence.daily-briefing.POST',
      new Error('Service role key not configured'),
      'no_service_key',
    )
  }

  try {
    const result = await buildDailyBriefing(service, user.id)

    // Upsert by (user_id, briefing_date) so re-running on the same day
    // overwrites the prior briefing instead of stacking duplicates.
    const { data, error } = await service
      .from('daily_briefings')
      .upsert(
        {
          user_id: user.id,
          briefing_date: result.payload.briefing_date,
          payload: result.payload,
          markdown: result.markdown,
          generated_at: result.payload.generated_at,
        },
        { onConflict: 'user_id,briefing_date' },
      )
      .select('*')
      .maybeSingle()

    if (error) {
      console.error('[daily-briefing] upsert failed', {
        message: error.message,
        code: error.code,
      })
      return apiServerError('intelligence.daily-briefing.POST', error, 'upsert_failed')
    }

    return NextResponse.json({
      briefing: data,
      payload: result.payload,
      markdown: result.markdown,
    })
  } catch (err) {
    return apiServerError('intelligence.daily-briefing.POST', err, 'generate_failed')
  }
}
