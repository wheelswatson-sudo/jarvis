// SMS ingestion — write inbound/outbound texts from the SMS Gateway for
// Android into the unified `messages` table. Mirrors the iMessage bridge in
// lib/imessage/sync.ts: load contacts → match phone → upsert with
// onConflict 'user_id,channel,external_id' for dedup → bump
// last_interaction_at on matched contacts.
//
// Used by both /api/sms/sync (historical batch pull) and /api/sms/webhook
// (single-message push from the gateway app).

import type { SupabaseClient } from '@supabase/supabase-js'
import { bumpLastInteractionAt } from '../google/gmail-sync'
import { makeSnippet } from '../util/snippet'
import { SMS_CHANNEL } from './gateway'

const MAX_BODY = 4000

export type IncomingSms = {
  // Stable per-message id from the gateway. Used for dedup via the
  // (user_id, channel, external_id) unique index on `messages`.
  gatewayId: string
  // 'inbound' (from the contact) or 'outbound' (sent by the user).
  direction: 'inbound' | 'outbound'
  // Counterparty phone in any format (will be normalized for matching).
  counterpartyPhone: string
  // SMS body. Empty bodies are skipped.
  body: string
  // ISO-8601 timestamp the message was sent/received.
  occurredAt: string
}

export type SmsStoreResult = {
  fetched: number
  imported: number
  skipped: number
  errors: number
  // Per-message report for the route to surface to the UI.
  reports: SmsReport[]
}

export type SmsReport = {
  gateway_id: string
  status: 'imported' | 'skipped' | 'error'
  contact_id?: string | null
  reason?: string
}

export async function storeSmsMessages(
  service: SupabaseClient,
  userId: string,
  incoming: IncomingSms[],
): Promise<SmsStoreResult> {
  if (incoming.length === 0) {
    return { fetched: 0, imported: 0, skipped: 0, errors: 0, reports: [] }
  }

  const { phoneToContactId } = await loadPhoneIndex(service, userId)

  let imported = 0
  let skipped = 0
  let errors = 0
  const reports: SmsReport[] = []
  const latestByContact = new Map<string, string>()

  for (const msg of incoming) {
    const body = (msg.body ?? '').trim()
    if (!body) {
      skipped++
      reports.push({ gateway_id: msg.gatewayId, status: 'skipped', reason: 'empty_body' })
      continue
    }

    const contactId = matchPhone(msg.counterpartyPhone, phoneToContactId)
    const truncated = body.slice(0, MAX_BODY)
    const isInbound = msg.direction === 'inbound'
    const sender = isInbound ? msg.counterpartyPhone : 'me'
    const recipient = isInbound ? 'me' : msg.counterpartyPhone

    const occurredAt = (() => {
      const d = new Date(msg.occurredAt)
      return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
    })()

    const row = {
      user_id: userId,
      contact_id: contactId,
      channel: SMS_CHANNEL,
      direction: msg.direction,
      sender,
      recipient,
      subject: null,
      body: truncated,
      snippet: makeSnippet(truncated),
      thread_id: null,
      external_id: msg.gatewayId,
      is_read: true,
      sent_at: occurredAt,
    }

    // ON CONFLICT DO NOTHING returns success with empty data on duplicate,
    // so we use .select() to distinguish a true insert from a dedup hit.
    // ignoreDuplicates+23505 (the iMessage path) is broken: 23505 never
    // fires under DO NOTHING, so every re-sync overcounts as "imported".
    const { data: insertedRows, error } = await service
      .from('messages')
      .upsert(row, {
        onConflict: 'user_id,channel,external_id',
        ignoreDuplicates: true,
      })
      .select('id')

    if (error) {
      errors++
      reports.push({
        gateway_id: msg.gatewayId,
        status: 'error',
        contact_id: contactId,
        reason: 'insert_failed',
      })
      console.warn('[sms-ingest] insert error:', error.message)
    } else if (!insertedRows || insertedRows.length === 0) {
      // Already in the DB. Conservative: count as skipped, don't bump
      // last_interaction_at since we can't tell whether this is the
      // newest message we've seen.
      skipped++
      reports.push({
        gateway_id: msg.gatewayId,
        status: 'skipped',
        contact_id: contactId,
        reason: 'already_synced',
      })
    } else {
      imported++
      reports.push({
        gateway_id: msg.gatewayId,
        status: 'imported',
        contact_id: contactId,
        reason: contactId ? undefined : 'no_matching_contact',
      })
      if (contactId) {
        const prev = latestByContact.get(contactId)
        if (!prev || occurredAt > prev) latestByContact.set(contactId, occurredAt)
      }
    }
  }

  await bumpLastInteractionAt(service, userId, latestByContact)

  return {
    fetched: incoming.length,
    imported,
    skipped,
    errors,
    reports,
  }
}

// Load all contacts that have a phone number, indexed by their normalized
// phone key (last 10 digits for US numbers). Matches the iMessage sync's
// loadContactLookup pattern so the two ingestion paths agree on what
// "the same contact" means.
async function loadPhoneIndex(
  service: SupabaseClient,
  userId: string,
): Promise<{ phoneToContactId: Map<string, string> }> {
  const { data: contacts } = await service
    .from('contacts')
    .select('id, phone')
    .eq('user_id', userId)
    .not('phone', 'is', null)
    .limit(10000)

  const phoneToContactId = new Map<string, string>()
  for (const c of (contacts ?? []) as { id: string; phone: string | null }[]) {
    if (!c.phone) continue
    const key = phoneKey(c.phone)
    if (key) phoneToContactId.set(key, c.id)
  }
  return { phoneToContactId }
}

// Match an SMS sender/recipient phone to a contact. Same approach as
// matchContact() in lib/imessage/sync.ts: prefer exact 10-digit match,
// fall back to last-7-digit only when it's an unambiguous hit. This avoids
// silently misattributing a conversation when two contacts share the same
// 7-digit suffix in different area codes.
function matchPhone(
  raw: string,
  phoneToContactId: Map<string, string>,
): string | null {
  const key = phoneKey(raw)
  if (!key) return null
  const exact = phoneToContactId.get(key)
  if (exact) return exact
  const tail7 = key.slice(-7)
  if (tail7.length < 7) return null
  let onlyMatch: string | null = null
  for (const [k, id] of phoneToContactId) {
    if (!k.endsWith(tail7)) continue
    if (onlyMatch !== null && onlyMatch !== id) return null
    onlyMatch = id
  }
  return onlyMatch
}

// Reduce a phone string to a comparable key — last 10 digits for US numbers,
// or the full digit string when shorter (e.g. short codes). Returns null
// when no digits at all. Mirrors lib/imessage/sync.ts:phoneKey so the
// SMS path matches identically to the iMessage path.
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '')
  if (!digits) return null
  return digits.length >= 10 ? digits.slice(-10) : digits
}
