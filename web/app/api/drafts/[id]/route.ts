import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { apiError } from '../../../../lib/api-errors'

export const dynamic = 'force-dynamic'

// PATCH /api/drafts/[id]
// Body: { body?: string, subject?: string, status?: 'pending'|'approved'|'sent'|'discarded' }
// Updates an owned draft. RLS enforces ownership.

const ALLOWED_STATUSES = new Set([
  'pending',
  'approved',
  'sent',
  'discarded',
] as const)

type AllowedStatus =
  | 'pending'
  | 'approved'
  | 'sent'
  | 'discarded'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  let body: { body?: unknown; subject?: unknown; status?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
  }

  const update: Record<string, unknown> = {}
  if (typeof body.body === 'string') update.body = body.body.slice(0, 16000)
  if (typeof body.subject === 'string')
    update.subject = body.subject.trim() || null
  if (typeof body.status === 'string') {
    if (!ALLOWED_STATUSES.has(body.status as AllowedStatus)) {
      return apiError(400, 'Invalid status', undefined, 'invalid_status')
    }
    update.status = body.status
  }

  if (Object.keys(update).length === 0) {
    return apiError(400, 'No fields to update', undefined, 'no_fields')
  }

  const { error } = await supabase
    .from('drafts')
    .update(update)
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[drafts/PATCH] update failed', error)
    return apiError(500, error.message, undefined, 'update_failed')
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const { error } = await supabase
    .from('drafts')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('[drafts/DELETE] failed', error)
    return apiError(500, error.message, undefined, 'delete_failed')
  }

  return NextResponse.json({ ok: true })
}
