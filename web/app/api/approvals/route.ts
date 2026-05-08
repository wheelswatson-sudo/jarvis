import { NextResponse } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import { apiError, apiServerError } from '../../../lib/api-errors'
import type { PendingChange, PendingChangeStatus } from '../../../lib/types'

export const dynamic = 'force-dynamic'

const VALID_STATUSES: PendingChangeStatus[] = ['pending', 'approved', 'rejected']

export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
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
    return apiServerError('approvals.GET', error, 'db_error')
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

  let body: CreateBody
  try {
    body = (await request.json()) as CreateBody
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
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
    return apiError(
      400,
      'contact_id, source, and field_name are required',
      undefined,
      'missing_fields',
    )
  }
  if (!ALLOWED_FIELDS.has(fieldName)) {
    return apiError(
      400,
      `field_name must be one of: ${[...ALLOWED_FIELDS].join(', ')}`,
      { allowed: [...ALLOWED_FIELDS] },
      'invalid_field_name',
    )
  }

  const { data: contact, error: contactErr } = await supabase
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (contactErr || !contact) {
    return apiError(404, 'Contact not found', undefined, 'contact_not_found')
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
    return apiServerError('approvals.POST', error, 'db_error')
  }

  return NextResponse.json({ change: data as PendingChange }, { status: 201 })
}

export async function DELETE(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return apiError(400, 'id required', undefined, 'missing_id')
  }

  const { error } = await supabase
    .from('pending_changes')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    return apiServerError('approvals.DELETE', error, 'db_error')
  }
  return NextResponse.json({ ok: true })
}
