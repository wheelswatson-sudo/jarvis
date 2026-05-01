import { NextResponse } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import type { PendingChange, PendingChangeStatus } from '../../../lib/types'

export const dynamic = 'force-dynamic'

const VALID_STATUSES: PendingChangeStatus[] = ['pending', 'approved', 'rejected']

export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const statusParam = url.searchParams.get('status') ?? 'pending'
  const status = (
    VALID_STATUSES.includes(statusParam as PendingChangeStatus)
      ? statusParam
      : 'pending'
  ) as PendingChangeStatus

  const { data, error } = await supabase
    .from('pending_changes')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', status)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ changes: (data ?? []) as PendingChange[] })
}

type CreateBody = {
  contact_id?: unknown
  source?: unknown
  field_name?: unknown
  old_value?: unknown
  new_value?: unknown
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

  let body: CreateBody
  try {
    body = (await request.json()) as CreateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const contactId = typeof body.contact_id === 'string' ? body.contact_id : ''
  const source = typeof body.source === 'string' ? body.source.trim() : ''
  const fieldName = typeof body.field_name === 'string' ? body.field_name : ''
  const oldValue =
    typeof body.old_value === 'string' || body.old_value === null
      ? (body.old_value as string | null)
      : null
  const newValue =
    typeof body.new_value === 'string' || body.new_value === null
      ? (body.new_value as string | null)
      : null

  if (!contactId || !source || !fieldName) {
    return NextResponse.json(
      { error: 'contact_id, source, and field_name are required' },
      { status: 400 },
    )
  }
  if (!ALLOWED_FIELDS.has(fieldName)) {
    return NextResponse.json(
      { error: `field_name must be one of: ${[...ALLOWED_FIELDS].join(', ')}` },
      { status: 400 },
    )
  }

  const { data: contact, error: contactErr } = await supabase
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (contactErr || !contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('pending_changes')
    .insert({
      user_id: user.id,
      contact_id: contactId,
      source,
      field_name: fieldName,
      old_value: oldValue,
      new_value: newValue,
      status: 'pending',
    })
    .select('*')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ change: data as PendingChange }, { status: 201 })
}

export async function DELETE(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const { error } = await supabase
    .from('pending_changes')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
