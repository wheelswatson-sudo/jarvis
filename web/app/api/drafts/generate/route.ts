import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { generateDraftReply } from '../../../../lib/intelligence/draft-reply'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/drafts/generate
//
// Body: { message_id: string, contact_id: string, trigger?: string }
// Returns: { ok, draft_id, subject, reasoning } — the body is intentionally
// not returned in the JSON; the review page fetches it from /api/drafts/<id>.
// This keeps the response small and consistent with the row stored in the
// drafts table.

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  let body: { message_id?: unknown; contact_id?: unknown; trigger?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
  }

  const messageId = typeof body.message_id === 'string' ? body.message_id : ''
  const contactId = typeof body.contact_id === 'string' ? body.contact_id : ''
  const trigger =
    body.trigger === 'forgotten_loop' || body.trigger === 'manual'
      ? body.trigger
      : 'manual'

  if (!messageId || !contactId) {
    return apiError(
      400,
      'message_id and contact_id required',
      undefined,
      'missing_params',
    )
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

  const userName =
    (user.user_metadata?.full_name as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    (user.email ?? '').split('@')[0] ||
    'me'
  const userEmail = user.email ?? ''

  let draft: Awaited<ReturnType<typeof generateDraftReply>>
  try {
    draft = await generateDraftReply({
      service,
      userId: user.id,
      userName,
      userEmail,
      messageId,
      contactId,
    })
  } catch (err) {
    console.error('[drafts/generate] failed', err)
    return apiError(
      502,
      err instanceof Error ? err.message : 'Draft generation failed',
      undefined,
      'generation_failed',
    )
  }

  // Insert via service client to bypass RLS — the policy only allows
  // 'pending' on insert, but inserting through the user-scoped client
  // adds a roundtrip we don't need. We're already authenticated and
  // scoping by user.id manually.
  const { data: row, error: insertErr } = await service
    .from('drafts')
    .insert({
      user_id: user.id,
      contact_id: contactId,
      message_id: messageId,
      trigger,
      subject: draft.subject,
      body: draft.body,
      model: draft.model.id,
      reasoning: draft.reasoning,
      status: 'pending',
    })
    .select('id')
    .single()

  if (insertErr || !row) {
    console.error('[drafts/generate] insert failed', insertErr)
    return apiError(500, 'Failed to save draft', undefined, 'insert_failed')
  }

  return NextResponse.json({
    ok: true,
    draft_id: row.id,
    subject: draft.subject,
    reasoning: draft.reasoning,
    model: draft.model.id,
  })
}
