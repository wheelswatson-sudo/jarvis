// Cron-callable Gmail sync helper.
//
// Mirrors the work that /api/google/gmail/sync + /api/gmail/sync do when
// invoked from a browser session, but takes (userId, userEmail, accessToken)
// directly so it works without a Supabase auth cookie. Used by the daily
// cron route. The interactive routes still drive their own copy of this
// logic — keep them working until we collapse them into this helper.
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
  for (const msg of messages) {
    const fromEmail = normalizeEmail(msg.from)
    const toEmail = normalizeEmail(msg.to)
    const isInbound = fromEmail !== lowerUserEmail
    const otherEmail = isInbound ? fromEmail : toEmail
    const contactId = emailToContactId.get(otherEmail) ?? null

    const row = {
      user_id: userId,
      contact_id: contactId,
      channel: 'email',
      direction: isInbound ? 'inbound' : 'outbound',
      sender: msg.from,
      recipient: msg.to,
      subject: msg.subject || null,
      body: msg.body,
      snippet: makeSnippet(msg.body),
      thread_id: msg.threadId || null,
      external_id: msg.id,
      is_read: true,
      sent_at: new Date(msg.date).toISOString(),
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
    }
  }

  return { fetched: messages.length, imported, skipped, errors, messages }
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

      const commitmentRows = signals.commitments.map((c) => ({
        user_id: userId,
        contact_id: contact.id,
        interaction_id: interactionRow.id,
        description: c.description,
        due_at: c.due_at,
        owner: ownerToDb(c.owner),
        status: 'open' as const,
      }))

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

function makeSnippet(body: string): string {
  return body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
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
