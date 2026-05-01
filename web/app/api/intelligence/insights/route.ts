import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { apiError } from '../../../../lib/api-errors'
import { trackEvent } from '../../../../lib/events'
import type { IntelligenceInsight } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

// GET — returns the user's pending insights, ordered priority + recency.
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
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
    return apiError(500, error.message, undefined, 'query_failed')
  }

  return NextResponse.json({ insights: (data ?? []) as IntelligenceInsight[] })
}

// POST — act on or dismiss an insight.
//   { id: string, action: 'act' | 'dismiss' }
type PostBody = { id?: unknown; action?: unknown }

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
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

  const { data, error } = await supabase
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
    return apiError(500, error.message, undefined, 'update_failed')
  }
  if (!data) {
    return apiError(404, 'Insight not found or already resolved', undefined, 'not_found')
  }

  // Fire-and-forget feedback event to feed the self-improvement loop.
  void trackEvent({
    userId: user.id,
    eventType: action === 'act' ? 'insight_acted_on' : 'insight_dismissed',
    metadata: {
      insight_id: data.id,
      insight_type: data.insight_type,
      insight_key: data.insight_key,
      capsule_id: data.capsule_id,
    },
  })

  return NextResponse.json({ ok: true, status: newStatus })
}
