import { NextResponse } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'
import { apiError, dbError } from '../../../../../lib/api-errors'
import type { OutboundAction } from '../../../../../lib/types'

export const dynamic = 'force-dynamic'

// Default check-in window after an intro fires. The user can edit the
// resulting commitment to slide it earlier or later.
const FOLLOW_UP_DAYS = 7

// POST /api/intros/[id]/sent
// Marks an intro outbound_action as sent and creates a follow-up
// commitment to check whether the intro actually led to a meeting.
// Idempotent — if status is already 'sent', returns the existing row
// without re-inserting another follow-up.
export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  if (!id) return apiError(400, 'id required', undefined, 'missing_id')

  const { data: existing, error: fetchErr } = await supabase
    .from('outbound_actions')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (fetchErr) {
    return dbError('api/intros sent fetch', fetchErr, 500, 'select_failed')
  }
  const action = existing as OutboundAction | null
  if (!action) {
    return apiError(404, 'Intro not found', undefined, 'not_found')
  }
  if (action.channel !== 'intro') {
    return apiError(
      400,
      'Action is not an intro',
      undefined,
      'wrong_channel',
    )
  }

  if (action.status === 'sent') {
    // Already marked — return current state without creating a duplicate
    // follow-up commitment.
    return NextResponse.json({ intro: action, follow_up: null })
  }

  const sentAt = new Date()
  const { data: updated, error: updateErr } = await supabase
    .from('outbound_actions')
    .update({ status: 'sent', sent_at: sentAt.toISOString() })
    .eq('id', action.id)
    .eq('user_id', user.id)
    .select('*')
    .single()
  if (updateErr) {
    return dbError('api/intros sent update', updateErr, 500, 'update_failed')
  }

  // Create the follow-up. Due in FOLLOW_UP_DAYS, owner='me' (the user is
  // checking in), direction mirrored to satisfy the migration 016 NOT
  // NULL constraint. The commitment_type lets the home page filter these
  // out of the generic action list if it ever wants to.
  const dueAt = new Date(sentAt.getTime() + FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000)
  const { data: followUp, error: followErr } = await supabase
    .from('commitments')
    .insert({
      user_id: user.id,
      contact_id: action.contact_id,
      description: `Check in: did the intro lead to a meeting?`,
      notes: action.context,
      owner: 'me',
      direction: 'me',
      commitment_type: 'follow-up',
      due_at: dueAt.toISOString(),
      status: 'open',
    })
    .select('*')
    .single()
  if (followErr) {
    // The intro itself was marked sent — don't roll back. Surface the
    // follow-up failure separately so the UI can offer a retry.
    console.error('[api/intros sent] follow-up insert failed', followErr)
    return NextResponse.json({
      intro: updated as OutboundAction,
      follow_up: null,
      follow_up_error: 'insert_failed',
    })
  }

  return NextResponse.json({
    intro: updated as OutboundAction,
    follow_up: followUp,
  })
}
