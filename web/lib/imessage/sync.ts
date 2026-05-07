// Server-side persistence helpers for iMessage data pushed by the local
// bridge (bin/jarvis-imessage-bridge). Mirrors the split in
// lib/google/gmail-sync.ts:
//
//   1. storeImessages — upsert raw messages into the unified `messages`
//      table, dedup via the (user_id, channel, external_id) index.
//   2. extractAndStoreImessageCommitments — run the relationship extractor,
//      write `interactions` + `commitments`, fold signals into
//      contacts.personal_details.
//
// Vercel can't read ~/Library/Messages/chat.db. The local bridge does the
// reading and pushes a normalized payload here, so this module is auth- and
// network-agnostic — caller resolves the user.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  extractCommitments,
  type ExtractedCommitment,
} from '../intelligence/extract-commitments'
import { mergeSignalsIntoDetails } from '../intelligence/relationship-merge'
import { bumpLastInteractionAt } from '../google/gmail-sync'
import type { PersonalDetails } from '../types'

export const IMESSAGE_CHANNEL = 'imessage' as const

const MAX_BODY = 4000
const MAX_INTERACTION_BODY = 4000
const MAX_SNIPPET = 140

// Shape of a single message pushed by the local bridge. Keep this in sync
// with bin/jarvis-imessage-bridge.
export type IncomingImessage = {
  // Stable per-message id from chat.db (message.guid). Used for dedup.
  guid: string
  // chat.db `chat.guid` for threading. May be null for orphan rows.
  chat_guid?: string | null
  // E.164 phone or email of the other party.
  handle: string
  // Pretty display name resolved from AddressBook, if available.
  handle_name?: string | null
  // 'inbound' (from contact) or 'outbound' (from user).
  direction: 'inbound' | 'outbound'
  // Plain message text. Empty / pure-attachment rows should be filtered
  // by the bridge before pushing.
  text: string
  // ISO-8601 timestamp.
  sent_at: string
  // chat.db is_read flag, if known.
  is_read?: boolean
  // 'iMessage' or 'SMS' — informational only.
  service?: string | null
}

export type ImessageStoreResult = {
  fetched: number
  imported: number
  skipped: number
  errors: number
  // Echo of the persisted-or-skipped payload, with contact_id resolved,
  // so the caller can hand it straight to the extractor.
  messages: PersistedImessage[]
}

export type PersistedImessage = IncomingImessage & {
  contact_id: string | null
}

export type ImessageExtractResult = {
  processed: number
  skipped: number
  errors: number
  commitments_created: number
}

// Persist a batch of iMessages. Returns the same payload (with contact_id
// resolved) so the extractor can consume it without a second DB round-trip.
export async function storeImessages(
  service: SupabaseClient,
  userId: string,
  incoming: IncomingImessage[],
): Promise<ImessageStoreResult> {
  if (incoming.length === 0) {
    return { fetched: 0, imported: 0, skipped: 0, errors: 0, messages: [] }
  }

  const { phoneToContactId, emailToContactId } = await loadContactLookup(
    service,
    userId,
  )

  let imported = 0
  let skipped = 0
  let errors = 0
  const latestByContact = new Map<string, string>()
  const persisted: PersistedImessage[] = []

  for (const msg of incoming) {
    const contactId = matchContact(msg.handle, phoneToContactId, emailToContactId)
    const sentAt = new Date(msg.sent_at).toISOString()
    const text = (msg.text ?? '').slice(0, MAX_BODY)
    if (!text.trim()) {
      skipped++
      continue
    }

    const isInbound = msg.direction === 'inbound'
    const sender = isInbound ? msg.handle : 'me'
    const recipient = isInbound ? 'me' : msg.handle

    const row = {
      user_id: userId,
      contact_id: contactId,
      channel: IMESSAGE_CHANNEL,
      direction: msg.direction,
      sender,
      recipient,
      subject: null,
      body: text,
      snippet: makeSnippet(text),
      thread_id: msg.chat_guid ?? null,
      external_id: msg.guid,
      is_read: msg.is_read ?? true,
      sent_at: sentAt,
    }

    const { error } = await service.from('messages').upsert(row, {
      onConflict: 'user_id,channel,external_id',
      ignoreDuplicates: true,
    })

    if (error) {
      if (error.code === '23505') skipped++
      else {
        errors++
        console.warn('[imessage-sync] insert error:', error.message)
      }
    } else {
      imported++
      if (contactId) {
        const prev = latestByContact.get(contactId)
        if (!prev || sentAt > prev) latestByContact.set(contactId, sentAt)
      }
    }

    persisted.push({ ...msg, contact_id: contactId })
  }

  await bumpLastInteractionAt(service, userId, latestByContact)

  return {
    fetched: incoming.length,
    imported,
    skipped,
    errors,
    messages: persisted,
  }
}

// Run the relationship extractor over messages that landed via storeImessages
// and write interactions + commitments + personal_details updates. Mirrors
// gmail-sync.ts:extractAndStoreCommitments — the only changes are the source
// prefix and the message shape.
export async function extractAndStoreImessageCommitments(
  service: SupabaseClient,
  userId: string,
  messages: PersistedImessage[],
): Promise<ImessageExtractResult> {
  if (messages.length === 0) {
    return { processed: 0, skipped: 0, errors: 0, commitments_created: 0 }
  }

  type ContactRow = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
    company: string | null
    personal_details: PersonalDetails | null
  }

  const { data: contactRows } = await service
    .from('contacts')
    .select(
      'id, first_name, last_name, email, phone, company, personal_details',
    )
    .eq('user_id', userId)

  const contactsById = new Map<string, ContactRow>()
  for (const c of (contactRows ?? []) as ContactRow[]) {
    contactsById.set(c.id, c)
  }

  const candidateSources = messages.map((m) => `imessage:${m.guid}`)
  const { data: existingRows } = await service
    .from('interactions')
    .select('source')
    .eq('user_id', userId)
    .in('source', candidateSources)
  const alreadySynced = new Set(
    ((existingRows ?? []) as { source: string | null }[])
      .map((r) => r.source)
      .filter((s): s is string => typeof s === 'string'),
  )

  let processed = 0
  let skipped = 0
  let errors = 0
  let commitmentsCreated = 0

  for (const msg of messages) {
    try {
      if (alreadySynced.has(`imessage:${msg.guid}`)) {
        skipped++
        continue
      }
      if (!msg.contact_id) {
        // No matched contact — nothing to enrich. The raw message still
        // sits in `messages` for unified-inbox views.
        skipped++
        continue
      }

      const row = contactsById.get(msg.contact_id)
      if (!row) {
        skipped++
        continue
      }

      const contact = {
        id: row.id,
        name:
          [row.first_name, row.last_name].filter(Boolean).join(' ').trim() ||
          msg.handle_name ||
          null,
        email: row.email,
        company: row.company,
      }

      const occurredAt = new Date(msg.sent_at).toISOString()
      const direction: 'inbound' | 'outbound' = msg.direction
      const body = (msg.text ?? '').slice(0, MAX_INTERACTION_BODY)

      const signals = await extractCommitments(body, contact)
      const summary =
        signals.meaningful_summary?.trim() ||
        signals.key_points[0] ||
        makeSnippet(body) ||
        null

      const { data: interactionRow, error: ixErr } = await service
        .from('interactions')
        .insert({
          user_id: userId,
          contact_id: contact.id,
          channel: IMESSAGE_CHANNEL,
          direction,
          type: 'text',
          summary,
          body,
          sentiment: signals.sentiment,
          key_points: signals.key_points,
          action_items: signals.action_items.map((d) => ({
            description: d,
            owner: 'me',
          })),
          source: `imessage:${msg.guid}`,
          occurred_at: occurredAt,
        })
        .select('id')
        .single()

      if (ixErr || !interactionRow) {
        errors++
        continue
      }

      const commitmentRows = signals.commitments.map((c) => {
        const owner = ownerToDb(c.owner)
        return {
          user_id: userId,
          contact_id: contact.id,
          interaction_id: interactionRow.id,
          description: c.description,
          due_at: c.due_at,
          owner,
          direction: owner,
          status: 'open' as const,
        }
      })

      if (commitmentRows.length > 0) {
        const { error: cmtErr } = await service
          .from('commitments')
          .insert(commitmentRows)
        if (!cmtErr) commitmentsCreated += commitmentRows.length
      }

      const latestRow = contactsById.get(row.id) ?? row
      const mergedDetails = mergeSignalsIntoDetails(
        latestRow.personal_details,
        signals,
        { occurredAt, channel: IMESSAGE_CHANNEL, direction },
      )
      await service
        .from('contacts')
        .update({
          personal_details: mergedDetails,
          last_interaction_at: occurredAt,
        })
        .eq('id', row.id)
        .eq('user_id', userId)
      contactsById.set(row.id, { ...latestRow, personal_details: mergedDetails })

      processed++
    } catch (err) {
      errors++
      console.warn(
        '[imessage-sync] extract error',
        err instanceof Error ? err.message : err,
      )
    }
  }

  return {
    processed,
    skipped,
    errors,
    commitments_created: commitmentsCreated,
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadContactLookup(
  service: SupabaseClient,
  userId: string,
): Promise<{
  phoneToContactId: Map<string, string>
  emailToContactId: Map<string, string>
}> {
  const { data: contacts } = await service
    .from('contacts')
    .select('id, email, phone')
    .eq('user_id', userId)
    .limit(10000)

  const phoneToContactId = new Map<string, string>()
  const emailToContactId = new Map<string, string>()
  for (const c of (contacts ?? []) as {
    id: string
    email: string | null
    phone: string | null
  }[]) {
    if (c.email) emailToContactId.set(c.email.toLowerCase().trim(), c.id)
    if (c.phone) {
      const key = phoneKey(c.phone)
      if (key) phoneToContactId.set(key, c.id)
    }
  }
  return { phoneToContactId, emailToContactId }
}

// Match a chat.db handle to a contact_id. Phones from chat.db are typically
// E.164 (`+15551234567`); contacts.phone is hand-entered and may be in any
// format. We normalize both to the trailing 10 digits for US numbers, with a
// fallback to the trailing 7 digits when one side is missing the area code.
function matchContact(
  handle: string,
  phoneToContactId: Map<string, string>,
  emailToContactId: Map<string, string>,
): string | null {
  const h = (handle ?? '').trim()
  if (!h) return null
  if (h.includes('@')) return emailToContactId.get(h.toLowerCase()) ?? null
  const key = phoneKey(h)
  if (!key) return null
  // Exact 10-digit match preferred.
  const exact = phoneToContactId.get(key)
  if (exact) return exact
  // Last-7 fallback handles rows where the area code is missing on one side.
  const tail7 = key.slice(-7)
  for (const [k, id] of phoneToContactId) {
    if (k.endsWith(tail7)) return id
  }
  return null
}

// Reduce a phone string to a comparable key — last 10 digits for US numbers,
// or the full digit string when shorter. Returns null when no digits at all.
function phoneKey(raw: string): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '')
  if (!digits) return null
  return digits.length >= 10 ? digits.slice(-10) : digits
}

function makeSnippet(body: string): string {
  return body
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SNIPPET)
}

function ownerToDb(o: ExtractedCommitment['owner']): 'me' | 'them' {
  return o === 'contact' ? 'them' : 'me'
}
