import { NextResponse } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import { apiError, dbError } from '../../../lib/api-errors'
import { buildIntroDraft } from '../../../lib/intro-template'
import { introEventHash } from '../../../lib/intro-detection'
import type { Contact, OutboundAction } from '../../../lib/types'

export const dynamic = 'force-dynamic'

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length === 0 ? null : t
}

function senderNameFromUser(user: {
  user_metadata?: { full_name?: string; name?: string; first_name?: string } | null
  email?: string | null
}): string | null {
  const md = user.user_metadata ?? {}
  if (md.full_name) return md.full_name
  if (md.name) return md.name
  if (md.first_name) return md.first_name
  return user.email ?? null
}

// GET /api/intros — list outbound intro drafts for the home page.
// status filter optional; defaults to 'draft' (the pending queue).
export async function GET(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? 'draft'

  const { data, error } = await supabase
    .from('outbound_actions')
    .select('*')
    .eq('user_id', user.id)
    .eq('channel', 'intro')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return dbError('api/intros GET', error, 500, 'select_failed')

  return NextResponse.json({ intros: (data ?? []) as OutboundAction[] })
}

// POST /api/intros
// body: { source_contact_id, target_contact_id, reason? }
// Builds a deterministic double-opt-in draft, inserts an outbound_actions
// row with status='draft' and channel='intro'. Dedups by event_hash so
// repeated submits return the existing row.
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

  const sourceId = clean(b.source_contact_id)
  const targetId = clean(b.target_contact_id)
  const reason = clean(b.reason)

  if (!sourceId || !targetId) {
    return apiError(
      400,
      'source_contact_id and target_contact_id required',
      undefined,
      'missing_contact',
    )
  }
  if (sourceId === targetId) {
    return apiError(
      400,
      'Cannot introduce a contact to themselves',
      undefined,
      'same_contact',
    )
  }

  // Pull both contacts in one round-trip. RLS scopes to the current user so
  // this also enforces ownership: a contact id the user doesn't own won't
  // come back.
  const { data: contactsData, error: contactsErr } = await supabase
    .from('contacts')
    .select('*')
    .in('id', [sourceId, targetId])
  if (contactsErr) {
    return dbError('api/intros POST contacts', contactsErr, 500, 'select_failed')
  }
  const contacts = (contactsData ?? []) as Contact[]
  const source = contacts.find((c) => c.id === sourceId)
  const target = contacts.find((c) => c.id === targetId)
  if (!source || !target) {
    return apiError(404, 'Contact not found', undefined, 'contact_not_found')
  }

  const senderName = senderNameFromUser(user)
  const { subject, body: draft } = buildIntroDraft({
    source,
    target,
    reason,
    senderName,
  })

  const hash = introEventHash(source.id, target.id, 'intro')

  // Build the recipient as "name <email>; name <email>" so the user can
  // copy-paste into Gmail. If either email is missing the draft still
  // lands — the user just edits before sending.
  const recipientParts: string[] = []
  if (source.email) recipientParts.push(`${source.email}`)
  if (target.email) recipientParts.push(`${target.email}`)
  const recipient = recipientParts.length > 0 ? recipientParts.join(', ') : null

  // The source contact is the primary `contact_id` for filtering on the
  // contact detail page. The target's involvement is reconstructable from
  // the draft body / context line.
  const { data: inserted, error: insertErr } = await supabase
    .from('outbound_actions')
    .upsert(
      {
        user_id: user.id,
        contact_id: source.id,
        channel: 'intro',
        recipient,
        subject,
        draft,
        context: `Intro from ${source.id} to ${target.id}${reason ? `: ${reason}` : ''}`,
        status: 'draft',
        event_hash: hash,
      },
      { onConflict: 'user_id,event_hash', ignoreDuplicates: false },
    )
    .select('*')
    .single()
  if (insertErr) {
    return dbError('api/intros POST insert', insertErr, 500, 'insert_failed')
  }

  return NextResponse.json({ intro: inserted as OutboundAction })
}

// PATCH /api/intros — update an existing draft (edit body, cancel, etc.)
// body: { id, draft? subject? status? }
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
  if (!id) return apiError(400, 'id required', undefined, 'missing_id')

  const updates: Record<string, unknown> = {}
  if (b.draft !== undefined) {
    const d = clean(b.draft)
    if (d) updates.draft = d
  }
  if (b.subject !== undefined) {
    updates.subject = clean(b.subject)
  }
  if (typeof b.status === 'string') {
    // Only allow user-driven status transitions here. 'sent' goes through
    // POST /api/intros/[id]/sent so the follow-up commitment is created
    // in the same transaction.
    if (b.status === 'cancelled' || b.status === 'draft') {
      updates.status = b.status
    } else {
      return apiError(
        400,
        'status must be draft or cancelled',
        undefined,
        'invalid_status',
      )
    }
  }

  if (Object.keys(updates).length === 0) {
    return apiError(400, 'no fields to update', undefined, 'no_updates')
  }

  const { data, error } = await supabase
    .from('outbound_actions')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('channel', 'intro')
    .select('*')
    .single()
  if (error) return dbError('api/intros PATCH', error, 500, 'update_failed')

  return NextResponse.json({ intro: data as OutboundAction })
}
