import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { apiError, dbError } from '../../../../lib/api-errors'
import { trackContactUpdate } from '../../../../lib/events'
import type { PendingChange } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

type ResolveBody = {
  ids?: unknown
  action?: unknown
}

const ALLOWED_FIELDS = new Set([
  'first_name',
  'last_name',
  'email',
  'phone',
  'company',
  'title',
  'linkedin',
])

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  let body: ResolveBody
  try {
    body = (await request.json()) as ResolveBody
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : []
  const action = body.action
  if (ids.length === 0) {
    return apiError(400, 'ids array required', undefined, 'missing_ids')
  }
  if (action !== 'approve' && action !== 'reject') {
    return apiError(
      400,
      "action must be 'approve' or 'reject'",
      undefined,
      'invalid_action',
    )
  }

  const { data: changes, error: fetchErr } = await supabase
    .from('pending_changes')
    .select('*')
    .in('id', ids)
    .eq('user_id', user.id)
    .eq('status', 'pending')

  if (fetchErr) {
    return dbError('api/approvals/resolve fetch', fetchErr)
  }
  const pending = (changes ?? []) as PendingChange[]
  if (pending.length === 0) {
    return NextResponse.json({ resolved: 0, applied: 0 })
  }

  const nowIso = new Date().toISOString()
  let applied = 0

  if (action === 'approve') {
    const byContact = new Map<string, PendingChange[]>()
    for (const c of pending) {
      if (!ALLOWED_FIELDS.has(c.field_name)) continue
      const list = byContact.get(c.contact_id) ?? []
      list.push(c)
      byContact.set(c.contact_id, list)
    }

    for (const [contactId, list] of byContact) {
      const update: Record<string, string | null> = {}
      for (const c of list) {
        update[c.field_name] = c.new_value
      }
      const { error: upErr } = await supabase
        .from('contacts')
        .update(update)
        .eq('id', contactId)
        .eq('user_id', user.id)
      if (upErr) {
        return dbError('api/approvals/resolve apply', upErr)
      }
      applied += list.length
      void trackContactUpdate(user.id, contactId, {
        source: 'approval',
        fields: list.map((c) => c.field_name),
      })
    }
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected'
  const { error: resolveErr } = await supabase
    .from('pending_changes')
    .update({ status: newStatus, resolved_at: nowIso })
    .in(
      'id',
      pending.map((c) => c.id),
    )
    .eq('user_id', user.id)

  if (resolveErr) {
    return dbError('api/approvals/resolve mark', resolveErr)
  }

  return NextResponse.json({ resolved: pending.length, applied })
}
