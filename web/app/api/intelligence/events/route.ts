import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { apiError } from '../../../../lib/api-errors'
import type { EventType } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

const ALLOWED: EventType[] = [
  'contact_viewed',
  'contact_updated',
  'outreach_sent',
  'commitment_created',
  'commitment_completed',
  'commitment_missed',
  'import_completed',
  'chat_query',
  'insight_dismissed',
  'insight_acted_on',
]

const ALLOWED_SET = new Set<EventType>(ALLOWED)

type EventBody = {
  event_type?: unknown
  contact_id?: unknown
  metadata?: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  let body: EventBody
  try {
    body = (await request.json()) as EventBody
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
  }

  const eventType = body.event_type
  if (typeof eventType !== 'string' || !ALLOWED_SET.has(eventType as EventType)) {
    return apiError(
      400,
      'event_type must be one of the supported types',
      { allowed: ALLOWED },
      'invalid_event_type',
    )
  }

  const contactId =
    typeof body.contact_id === 'string' && body.contact_id.length > 0
      ? body.contact_id
      : null

  if (contactId) {
    const { data: owned, error: ownerErr } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (ownerErr) {
      return apiError(500, ownerErr.message, undefined, 'contact_lookup_failed')
    }
    if (!owned) {
      return apiError(403, 'Contact does not belong to user', undefined, 'forbidden_contact')
    }
  }

  const metadata = isPlainObject(body.metadata) ? body.metadata : {}

  if (JSON.stringify(metadata).length > 4096) {
    return apiError(
      400,
      'metadata exceeds 4096-byte limit',
      undefined,
      'metadata_too_large',
    )
  }

  const { error } = await supabase.from('events').insert({
    user_id: user.id,
    event_type: eventType,
    contact_id: contactId,
    metadata,
  })

  if (error) {
    return apiError(500, error.message, undefined, 'insert_failed')
  }

  return NextResponse.json({ ok: true })
}
