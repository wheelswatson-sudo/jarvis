import { NextResponse } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import { apiError } from '../../../lib/api-errors'
import { trackEvent } from '../../../lib/events'
import type { ActionItem, InteractionType } from '../../../lib/types'

export const dynamic = 'force-dynamic'

const VALID_TYPES = new Set<InteractionType>([
  'call',
  'meeting',
  'email',
  'text',
  'in-person',
  'other',
])

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length === 0 ? null : t
}

function normalizeKeyPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => clean(v))
    .filter((v): v is string => v !== null)
}

function normalizeActionItems(value: unknown): ActionItem[] {
  if (!Array.isArray(value)) return []
  const out: ActionItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const desc = clean(r.description)
    if (!desc) continue
    const owner = r.owner === 'them' ? 'them' : 'me'
    const due = clean(r.due_date)
    out.push({
      description: desc,
      owner,
      due_date: due,
      completed: r.completed === true,
    })
  }
  return out
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const url = new URL(req.url)
  const contactId = url.searchParams.get('contact_id')
  const limit = Math.min(
    Number(url.searchParams.get('limit') ?? 100) || 100,
    500,
  )

  let q = supabase
    .from('interactions')
    .select('*')
    .eq('user_id', user.id)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (contactId) q = q.eq('contact_id', contactId)

  const { data, error } = await q
  if (error) return apiError(500, error.message, undefined, 'select_failed')

  return NextResponse.json({ interactions: data ?? [] })
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

  const contactId = clean(b.contact_id)
  if (!contactId) {
    return apiError(400, 'contact_id is required', undefined, 'missing_contact')
  }

  const { data: contact, error: cErr } = await supabase
    .from('contacts')
    .select('id, user_id')
    .eq('id', contactId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (cErr || !contact) {
    return apiError(404, 'Contact not found', undefined, 'contact_not_found')
  }

  const typeRaw = clean(b.type)
  const type: InteractionType =
    typeRaw && VALID_TYPES.has(typeRaw as InteractionType)
      ? (typeRaw as InteractionType)
      : 'other'

  const occurredAt = clean(b.date) ?? clean(b.occurred_at) ?? new Date().toISOString()
  const summary = clean(b.summary)
  const channel = clean(b.channel) ?? type
  const direction =
    b.direction === 'inbound' || b.direction === 'outbound'
      ? (b.direction as 'inbound' | 'outbound')
      : null
  const keyPoints = normalizeKeyPoints(b.key_points)
  const actionItems = normalizeActionItems(b.action_items)
  const followUp = clean(b.follow_up_date)
  const source = clean(b.source) ?? 'manual'
  const transcriptData =
    b.transcript_data && typeof b.transcript_data === 'object'
      ? (b.transcript_data as Record<string, unknown>)
      : null

  const insertRow = {
    user_id: user.id,
    contact_id: contactId,
    type,
    channel,
    direction,
    summary,
    body: clean(b.body),
    key_points: keyPoints,
    action_items: actionItems,
    follow_up_date: followUp,
    transcript_data: transcriptData,
    source,
    occurred_at: occurredAt,
  }

  const { data: inserted, error } = await supabase
    .from('interactions')
    .insert(insertRow)
    .select('*')
    .single()
  if (error) return apiError(400, error.message, undefined, 'insert_failed')

  // Auto-create commitments from action items where owner is 'me'.
  const myItems = actionItems.filter((a) => a.owner === 'me' && !a.completed)
  if (myItems.length > 0) {
    const commitmentRows = myItems.map((a) => ({
      user_id: user.id,
      contact_id: contactId,
      interaction_id: inserted.id,
      description: a.description,
      due_at: a.due_date ?? null,
      owner: a.owner,
      status: 'open' as const,
    }))
    await supabase.from('commitments').insert(commitmentRows)
  }

  // Update contact rollups: last_interaction_at, next_follow_up if new is sooner.
  const updates: Record<string, unknown> = { last_interaction_at: occurredAt }
  if (followUp) {
    const { data: existing } = await supabase
      .from('contacts')
      .select('next_follow_up')
      .eq('id', contactId)
      .maybeSingle()
    const cur = existing?.next_follow_up
      ? new Date(existing.next_follow_up).getTime()
      : Infinity
    if (new Date(followUp).getTime() < cur) updates.next_follow_up = followUp
  }
  await supabase.from('contacts').update(updates).eq('id', contactId)

  void trackEvent({
    userId: user.id,
    eventType: 'contact_updated',
    contactId,
    metadata: {
      action: 'interaction_logged',
      type,
      key_points_count: keyPoints.length,
      action_items_count: actionItems.length,
    },
  })

  return NextResponse.json({ interaction: inserted })
}
