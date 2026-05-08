import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import { apiError } from '../../../lib/api-errors'

export const dynamic = 'force-dynamic'

// GET /api/inbox?channel=email&unread=true&limit=50&offset=0
//
// Fetches messages from the unified inbox, optionally filtered by channel.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const url = new URL(req.url)
  const channel = url.searchParams.get('channel')        // 'email' | 'sms' | etc.
  const unread = url.searchParams.get('unread') === 'true'
  const starred = url.searchParams.get('starred') === 'true'
  const contactId = url.searchParams.get('contact_id')
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200)
  const offset = Number(url.searchParams.get('offset')) || 0

  let query = supabase
    .from('messages')
    .select(`
      id, channel, direction, sender, recipient, subject, snippet,
      thread_id, external_url, is_read, is_starred, is_archived,
      sent_at, contact_id,
      contacts:contact_id (id, first_name, last_name, email, phone, company)
    `)
    .eq('user_id', user.id)
    .eq('is_archived', false)
    .order('sent_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (channel) query = query.eq('channel', channel)
  if (unread) query = query.eq('is_read', false)
  if (starred) query = query.eq('is_starred', true)
  if (contactId) query = query.eq('contact_id', contactId)

  const { data, error, count } = await query

  if (error) {
    console.error('[api/inbox] GET query failed', error)
    return apiError(500, 'Failed to load inbox', undefined, 'query_failed')
  }

  return NextResponse.json({ messages: data ?? [], count })
}

// PATCH /api/inbox — bulk update messages (mark read, star, archive)
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const body = await req.json().catch(() => null)
  const ids = body?.ids as string[] | undefined
  const updates = body?.updates as Record<string, boolean> | undefined

  if (!ids || !Array.isArray(ids) || ids.length === 0 || !updates) {
    return apiError(400, 'ids[] and updates required', undefined, 'invalid_request')
  }

  // Only allow specific fields
  const allowed = ['is_read', 'is_starred', 'is_archived']
  const clean: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k) && typeof v === 'boolean') clean[k] = v
  }

  if (Object.keys(clean).length === 0) {
    return apiError(400, 'No valid updates', undefined, 'invalid_request')
  }

  const { error } = await supabase
    .from('messages')
    .update(clean)
    .eq('user_id', user.id)
    .in('id', ids)

  if (error) {
    console.error('[api/inbox] PATCH update failed', error)
    return apiError(500, 'Failed to update messages', undefined, 'update_failed')
  }

  return NextResponse.json({ ok: true, updated: ids.length })
}
