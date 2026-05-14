import { NextResponse } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import { apiError, apiServerError } from '../../../lib/api-errors'
import {
  trackCommitmentCreate,
  trackCommitmentComplete,
} from '../../../lib/events'
import type { CommitmentStatus } from '../../../lib/types'

export const dynamic = 'force-dynamic'

const VALID_STATUSES = new Set<CommitmentStatus>([
  'open',
  'done',
  'snoozed',
  'cancelled',
])

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length === 0 ? null : t
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const url = new URL(req.url)
  const contactId = url.searchParams.get('contact_id')
  const status = url.searchParams.get('status')
  const overdue = url.searchParams.get('overdue')

  let q = supabase
    .from('commitments')
    .select('*')
    .eq('user_id', user.id)
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (contactId) q = q.eq('contact_id', contactId)
  if (status && VALID_STATUSES.has(status as CommitmentStatus)) {
    q = q.eq('status', status)
  }
  if (overdue === 'true') {
    q = q.eq('status', 'open').lt('due_at', new Date().toISOString())
  }

  const { data, error } = await q
  if (error) return apiServerError('commitments.GET', error, 'select_failed')

  return NextResponse.json({ commitments: data ?? [] })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
  }
  const b = (body ?? {}) as Record<string, unknown>

  const description = clean(b.description)
  if (!description) {
    return apiError(400, 'description required', undefined, 'missing_description')
  }

  const owner = b.owner === 'them' ? 'them' : 'me'
  const due = clean(b.due_at)
  const contactId = clean(b.contact_id)
  const interactionId = clean(b.interaction_id)
  const notes = clean(b.notes)

  const { data: inserted, error } = await supabase
    .from('commitments')
    .insert({
      user_id: user.id,
      contact_id: contactId,
      interaction_id: interactionId,
      description,
      notes,
      owner,
      // commitments.direction is NOT NULL with a 'me' default; without
      // explicitly mirroring owner, every contact-owed row created here
      // would silently land as owner='them' direction='me'. Match the
      // pattern from gmail-sync, tasks-sync, imessage-sync, transcripts.
      direction: owner,
      due_at: due,
      status: 'open',
    })
    .select('*')
    .single()
  if (error) return apiError(400, error.message, undefined, 'insert_failed')

  void trackCommitmentCreate(user.id, contactId, {
    description,
    owner,
    has_due_date: !!due,
  })

  return NextResponse.json({ commitment: inserted })
}

export async function PATCH(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
  }
  const b = (body ?? {}) as Record<string, unknown>
  const id = clean(b.id)
  if (!id) {
    return apiError(400, 'id required', undefined, 'missing_id')
  }

  const updates: Record<string, unknown> = {}
  if (typeof b.status === 'string' && VALID_STATUSES.has(b.status as CommitmentStatus)) {
    updates.status = b.status
    if (b.status === 'done') updates.completed_at = new Date().toISOString()
    if (b.status === 'open') updates.completed_at = null
  }
  if (b.description !== undefined) {
    const d = clean(b.description)
    if (d) updates.description = d
  }
  if (b.due_at !== undefined) {
    updates.due_at = clean(b.due_at)
  }
  if (b.notes !== undefined) {
    updates.notes = clean(b.notes)
  }

  if (Object.keys(updates).length === 0) {
    return apiError(400, 'no fields to update', undefined, 'no_updates')
  }

  const { data, error } = await supabase
    .from('commitments')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select('*')
    .single()
  if (error) return apiError(400, error.message, undefined, 'update_failed')

  if (updates.status === 'done') {
    void trackCommitmentComplete(user.id, data.contact_id, {
      commitment_id: id,
    })
  }

  return NextResponse.json({ commitment: data })
}
