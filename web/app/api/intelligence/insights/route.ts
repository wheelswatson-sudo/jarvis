import { NextResponse, after } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError, apiServerError } from '../../../../lib/api-errors'
import { trackEvent } from '../../../../lib/events'
import type { IntelligenceInsight } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

// Mirrors proxy.ts: malformed/expired auth cookies can make getUser() throw.
// The route handler ran without a try/catch around it, so any throw bubbled
// up as an unhandled 500 — which is exactly what the dashboard surfaced as
// "Couldn't load insights — insights 500".
async function getAuthedUser() {
  const supabase = await createClient()
  try {
    const { data } = await supabase.auth.getUser()
    return { supabase, user: data.user }
  } catch (err) {
    console.error('[insights] getUser threw', err)
    return { supabase, user: null }
  }
}

// GET — returns the user's pending insights, ordered priority + recency.
export async function GET() {
  try {
    const { supabase, user } = await getAuthedUser()
    if (!user) {
      return apiError(401, 'Unauthorized', undefined, 'unauthorized')
    }

    const { data, error } = await supabase
      .from('intelligence_insights')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      console.error('[insights] query failed', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      })
      return apiServerError('intelligence.insights.GET', error, 'query_failed')
    }

    return NextResponse.json({ insights: (data ?? []) as IntelligenceInsight[] })
  } catch (err) {
    return apiServerError('intelligence.insights.GET', err, 'unhandled')
  }
}

// POST — act on or dismiss an insight.
//   { id: string, action: 'act' | 'dismiss' }
type PostBody = { id?: unknown; action?: unknown }

export async function POST(request: Request) {
  try {
    const { user } = await getAuthedUser()
    if (!user) {
      return apiError(401, 'Unauthorized', undefined, 'unauthorized')
    }

    let body: PostBody
    try {
      body = (await request.json()) as PostBody
    } catch {
      return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
    }

    const id = typeof body.id === 'string' ? body.id : null
    const action = body.action
    if (!id) return apiError(400, 'id is required', undefined, 'missing_id')
    if (action !== 'act' && action !== 'dismiss') {
      return apiError(
        400,
        "action must be 'act' or 'dismiss'",
        undefined,
        'invalid_action',
      )
    }

    const newStatus = action === 'act' ? 'acted_on' : 'dismissed'
    const nowIso = new Date().toISOString()

    // intelligence_insights has no user-side UPDATE policy — RLS would silently
    // block the write. Authenticate via the session client (above), then update
    // with the service-role client. Defense-in-depth: still scope to user_id.
    const service = getServiceClient()
    if (!service) {
      return apiServerError(
        'intelligence.insights.POST',
        new Error('Service role key not configured'),
        'no_service_key',
      )
    }

    const { data, error } = await service
      .from('intelligence_insights')
      .update({
        status: newStatus,
        acted_on_at: action === 'act' ? nowIso : null,
      })
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .select('id, insight_type, insight_key, capsule_id')
      .maybeSingle()

    if (error) {
      console.error('[insights] update failed', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      })
      return apiServerError('intelligence.insights.POST', error, 'update_failed')
    }
    if (!data) {
      return apiError(404, 'Insight not found or already resolved', undefined, 'not_found')
    }

    after(() =>
      trackEvent({
        userId: user.id,
        eventType: action === 'act' ? 'insight_acted_on' : 'insight_dismissed',
        metadata: {
          insight_id: data.id,
          insight_type: data.insight_type,
          insight_key: data.insight_key,
          capsule_id: data.capsule_id,
        },
      }),
    )

    return NextResponse.json({ ok: true, status: newStatus })
  } catch (err) {
    return apiServerError('intelligence.insights.POST', err, 'unhandled')
  }
}
