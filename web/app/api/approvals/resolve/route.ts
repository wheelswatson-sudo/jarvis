import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import type { PendingChange } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

type ResolveBody = {
  ids?: unknown
  action?: unknown
}

const ALLOWED_FIELDS = new Set([
  'name',
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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: ResolveBody
  try {
    body = (await request.json()) as ResolveBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : []
  const action = body.action
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })
  }
  if (action !== 'approve' && action !== 'reject') {
    return NextResponse.json(
      { error: "action must be 'approve' or 'reject'" },
      { status: 400 },
    )
  }

  const { data: changes, error: fetchErr } = await supabase
    .from('pending_changes')
    .select('*')
    .in('id', ids)
    .eq('user_id', user.id)
    .eq('status', 'pending')

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
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
        return NextResponse.json({ error: upErr.message }, { status: 500 })
      }
      applied += list.length
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
    return NextResponse.json({ error: resolveErr.message }, { status: 500 })
  }

  return NextResponse.json({ resolved: pending.length, applied })
}
