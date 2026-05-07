// Cron-callable Gmail sync helper. Single source of truth for Gmail
// ingestion + commitment extraction.
//
// Takes (userId, userEmail, accessToken) directly so it works without a
// Supabase auth cookie. Both call sites — /api/cron/daily-sync (server
// cron) and /api/google/gmail/sync (interactive browser button) — call
// this module's helpers in-process. No HTTP loopback.
//
// Two phases:
//   1. fetchAndStoreMessages — pull recent Gmail, upsert into `messages`
//   2. extractAndStoreCommitments — run the extractor, write interactions
//      and commitments, fold signals into contact.personal_details
//
// Both phases are dedup-aware: messages dedupe via the unique
// (user_id, channel, external_id) index; interactions dedupe by source
// = `gmail:<id>`.

import { google, type gmail_v1 } from 'googleapis'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildOAuthClient } from './oauth'
import {
  extractCommitments,
  type ExtractedCommitment,
} from '../intelligence/extract-commitments'
import { mergeSignalsIntoDetails } from '../intelligence/relationship-merge'
import { makeSnippet } from '../util/snippet'
import type { PersonalDetails } from '../types'

const DEFAULT_FILTER_TOKENS = [
  '-from:noreply',
  '-from:no-reply',
  '-from:notifications',
  '-from:hello@',
  '-from:info@',
  '-from:support@',
  '-from:service@',
  '-from:marketing',
  '-from:newsletter',
  '-from:digest',
  '-from:venmo.com',
  '-from:square.com',
  '-from:paypal.com',
  '-label:promotions',
  '-label:social',
] as const

export type GmailSyncOptions = {
  days?: number
  max?: number
  query?: string
}

export type SyncedMessage = {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  body: string
  date: string
}

export type GmailSyncResult = {
  fetched: number
  imported: number
  skipped: number
  errors: number
  messages: SyncedMessage[]
}

export async function fetchAndStoreGmail(
  service: SupabaseClient,
  userId: string,
  userEmail: string,
  accessToken: string,
  opts: GmailSyncOptions = {},
): Promise<GmailSyncResult> {
  const days = clampInt(opts.days, 1, 365, 90)
  const max = clampInt(opts.max, 1, 100, 25)
  const query = buildQuery(days, opts.query)

  const gmail = google.gmail({
    version: 'v1',
    auth: buildOAuthClient(accessToken),
  })

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: max,
    q: query,
  })
  const ids = (listRes.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string')

  if (ids.length === 0) {
    return { fetched: 0, imported: 0, skipped: 0, errors: 0, messages: [] }
  }

  const fetched = await Promise.all(
    ids.map(async (id): Promise<SyncedMessage | null> => {
      try {
        const r = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'full',
        })
        const headers = r.data.payload?.headers ?? []
        const text = decodeBody(
          r.data.payload as gmail_v1.Schema$MessagePart | undefined,
        )
        if (!text) return null
        return {
          id: r.data.id ?? id,
          threadId: r.data.threadId ?? id,
          from: getHeader(headers, 'From'),
          to: getHeader(headers, 'To'),
          subject: getHeader(headers, 'Subject'),
          body: text.slice(0, 20000),
          date: getHeader(headers, 'Date') || new Date().toISOString(),
        }
      } catch {
        return null
      }
    }),
  )
  const messages = fetched.filter((m): m is SyncedMessage => m !== null)

  const lowerUserEmail = userEmail.toLowerCase()
  const { data: contacts } = await service
    .from('contacts')
    .select('id, email')
    .eq('user_id', userId)
    .not('email', 'is', null)
    .limit(5000)
  const emailToContactId = new Map<string, string>()
  for (const c of (contacts ?? []) as { id: string; email: string | null }[]) {
    if (c.email) emailToContactId.set(c.email.toLowerCase().trim(), c.id)
  }

  let imported = 0
  let skipped = 0
  let errors = 0
  const latestByContact = new Map<string, string>()
  for (const msg of messages) {
    const fromEmail = normalizeEmail(msg.from)
    const toEmail = normalizeEmail(msg.to)
    const isInbound = fromEmail !== lowerUserEmail
    const otherEmail = isInbound ? fromEmail : toEmail
    const contactId = emailToContactId.get(otherEmail) ?? null
    const sentAt = new Date(msg.date).toISOString()

    const row = {
      user_id: userId,
      contact_id: contactId,
      channel: 'email',
      direction: isInbound ? 'inbound' : 'outbound',
      sender: msg.from,
      recipient: msg.to,
      subject: msg.subject || null,
      body: msg.body,
      snippet: makeSnippet(msg.body, { stripHtml: true }),
      thread_id: msg.threadId || null,
      external_id: msg.id,
      is_read: true,
      sent_at: sentAt,
    }

    const { error } = await service
      .from('messages')
      .upsert(row, {
        onConflict: 'user_id,channel,external_id',
        ignoreDuplicates: true,
      })
    if (error) {
      if (error.code === '23505') skipped++
      else {
        errors++
        console.warn('[gmail-sync helper] insert error:', error.message)
      }
    } else {
      imported++
      if (contactId) {
        const prev = latestByContact.get(contactId)
        if (!prev || sentAt > prev) latestByContact.set(contactId, sentAt)
      }
    }
  }

  await bumpLastInteractionAt(service, userId, latestByContact)

  return { fetched: messages.length, imported, skipped, errors, messages }
}

// Bump contacts.last_interaction_at to the most recent message timestamp for
// each contact we just touched. Only writes when the new timestamp is newer
// than what's already there — a stale resync of older mail must not regress
// the field.
export async function bumpLastInteractionAt(
  service: SupabaseClient,
  userId: string,
  latestByContact: Map<string, string>,
): Promise<void> {
  if (latestByContact.size === 0) return
  const ids = Array.from(latestByContact.keys())
  const { data: existing } = await service
    .from('contacts')
    .select('id, last_interaction_at')
    .eq('user_id', userId)
    .in('id', ids)
  const existingById = new Map<string, string | null>()
  for (const r of (existing ?? []) as {
    id: string
    last_interaction_at: string | null
  }[]) {
    existingById.set(r.id, r.last_interaction_at)
  }
  for (const [cid, ts] of latestByContact) {
    const cur = existingById.get(cid)
    if (cur && cur >= ts) continue
    await service
      .from('contacts')
      .update({ last_interaction_at: ts })
      .eq('id', cid)
      .eq('user_id', userId)
  }
}

export type ExtractionResult = {
  processed: number
  skipped: number
  errors: number
  commitments_created: number
}

export async function extractAndStoreCommitments(
  service: SupabaseClient,
  userId: string,
  userEmail: string,
  messages: SyncedMessage[],
): Promise<ExtractionResult> {
  if (messages.length === 0) {
    return { processed: 0, skipped: 0, errors: 0, commitments_created: 0 }
  }

  type ContactRow = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    company: string | null
    personal_details: PersonalDetails | null
  }

  const lowerUserEmail = userEmail.toLowerCase()

  const { data: allContactRows } = await service
    .from('contacts')
    .select('id, first_name, last_name, email, company, personal_details')
    .eq('user_id', userId)
    .not('email', 'is', null)

  const contactsByLowercaseEmail = new Map<string, ContactRow>()
  const contactsById = new Map<string, ContactRow>()
  for (const c of (allContactRows ?? []) as ContactRow[]) {
    if (c.email) contactsByLowercaseEmail.set(c.email.toLowerCase(), c)
    contactsById.set(c.id, c)
  }

  const candidateSources = messages.map((m) => `gmail:${m.id}`)
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
      if (alreadySynced.has(`gmail:${msg.id}`)) {
        skipped++
        continue
      }

      const fromEmail = normalizeEmail(msg.from)
      const toList: string[] = msg.to
        ? msg.to.split(',').map(normalizeEmail).filter(Boolean)
        : []

      const userIsSender = fromEmail === lowerUserEmail
      const counterpartyEmails = userIsSender
        ? toList.filter((e) => e && e !== lowerUserEmail)
        : [fromEmail].filter((e) => e && e !== lowerUserEmail)

      if (counterpartyEmails.length === 0) {
        skipped++
        continue
      }

      let row: ContactRow | undefined
      for (const e of counterpartyEmails) {
        const m = contactsByLowercaseEmail.get(e)
        if (m) {
          row = m
          break
        }
      }
      if (!row) {
        skipped++
        continue
      }

      const contact = {
        id: row.id,
        name:
          [row.first_name, row.last_name].filter(Boolean).join(' ').trim() ||
          null,
        email: row.email,
        // phone intentionally omitted — Gmail identifies contacts by
        // email, not phone. The iMessage path passes phone here as a
        // fallback identifier when email is null.
        company: row.company,
      }

      const occurredAt = msg.date
        ? new Date(msg.date).toISOString()
        : new Date().toISOString()
      const direction: 'inbound' | 'outbound' = userIsSender
        ? 'outbound'
        : 'inbound'

      const signals = await extractCommitments(msg.body, contact)
      const summary = msg.subject?.trim() || signals.key_points[0] || null

      const { data: interactionRow, error: ixErr } = await service
        .from('interactions')
        .insert({
          user_id: userId,
          contact_id: contact.id,
          channel: 'email',
          direction,
          type: 'email',
          summary,
          body: msg.body.slice(0, 20000),
          sentiment: signals.sentiment,
          key_points: signals.key_points,
          action_items: signals.action_items.map((d) => ({
            description: d,
            owner: 'me',
          })),
          source: `gmail:${msg.id}`,
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
          // commitments.direction is NOT NULL in prod; mirror owner.
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
        { occurredAt, channel: 'email', direction },
      )
      // last_interaction_at is intentionally NOT written here.
      // fetchAndStoreGmail() already called bumpLastInteractionAt() with a
      // "newer than current" guard. Writing it again unconditionally would
      // let a stale resync regress the field to an older value.
      await service
        .from('contacts')
        .update({ personal_details: mergedDetails })
        .eq('id', row.id)
        .eq('user_id', userId)
      contactsById.set(row.id, { ...latestRow, personal_details: mergedDetails })

      processed++
    } catch (err) {
      errors++
      console.warn(
        '[gmail-sync helper] extract error',
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

function buildQuery(days: number, override?: string | null): string {
  const trimmed = override?.trim()
  if (trimmed) return trimmed
  return [`newer_than:${days}d`, ...DEFAULT_FILTER_TOKENS].join(' ')
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  if (!Array.isArray(headers)) return ''
  return (
    headers.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())
      ?.value ?? ''
  )
}

function decodeBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return ''
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8')
    } catch {
      return ''
    }
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const text = decodeBody(part)
      if (text) return text
    }
  }
  return ''
}

function normalizeEmail(s: string): string {
  const m = s.match(/<([^>]+)>/)
  return (m?.[1] ?? s).trim().toLowerCase()
}

function ownerToDb(o: ExtractedCommitment['owner']): 'me' | 'them' {
  return o === 'contact' ? 'them' : 'me'
}

function clampInt(
  raw: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}
