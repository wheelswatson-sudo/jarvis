import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { LIMITS, rateLimitOr429 } from '../../../../lib/rate-limit'
import {
  extractCommitments,
  type ExtractedCommitment,
} from '../../../../lib/intelligence/extract-commitments'
import { mergeSignalsIntoDetails } from '../../../../lib/intelligence/relationship-merge'
import type { PersonalDetails } from '../../../../lib/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_MESSAGES = 25

type IncomingMessage = {
  id: string
  threadId?: string
  from: string
  to?: string | string[]
  subject?: string
  body: string
  date?: string
}

type SyncReport = {
  message_id: string
  status: 'processed' | 'skipped' | 'error'
  contact_id?: string | null
  commitments_created?: number
  error?: string
}

function normalizeEmail(s: string): string {
  const m = s.match(/<([^>]+)>/)
  const raw = (m?.[1] ?? s).trim().toLowerCase()
  return raw
}

function ownerToDb(o: ExtractedCommitment['owner']): 'me' | 'them' {
  return o === 'contact' ? 'them' : 'me'
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const limited = rateLimitOr429(
    `gmail-sync:${user.id}`,
    LIMITS.GMAIL_SYNC.limit,
    LIMITS.GMAIL_SYNC.windowMs,
  )
  if (limited) return limited

  const userEmail = (user.email ?? '').toLowerCase()

  const body = (await req.json().catch(() => null)) as
    | { messages?: unknown }
    | null
  const raw = Array.isArray(body?.messages) ? body!.messages : null
  if (!raw || raw.length === 0) {
    return apiError(400, 'messages is required', undefined, 'invalid_request')
  }
  const messages = (raw as unknown[])
    .filter((m): m is IncomingMessage =>
      !!m &&
      typeof (m as IncomingMessage).id === 'string' &&
      typeof (m as IncomingMessage).from === 'string' &&
      typeof (m as IncomingMessage).body === 'string',
    )
    .slice(0, MAX_MESSAGES)

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service role key not configured', undefined, 'service_unavailable')
  }

  // Pre-fetch all contacts with emails and build a case-insensitive lookup map.
  // This avoids N+1 queries (one per message) and handles the fact that
  // contacts.email is stored in mixed case but we normalize to lowercase.
  const { data: allContactRows } = await service
    .from('contacts')
    .select('id, first_name, last_name, email, company, personal_details')
    .eq('user_id', user.id)
    .not('email', 'is', null)

  type ContactRow = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    company: string | null
    personal_details: PersonalDetails | null
  }

  const contactsByLowercaseEmail = new Map<string, ContactRow>()
  const contactsById = new Map<string, ContactRow>()

  for (const contact of (allContactRows ?? []) as ContactRow[]) {
    if (contact.email) {
      contactsByLowercaseEmail.set(contact.email.toLowerCase(), contact)
    }
    contactsById.set(contact.id, contact)
  }

  // Idempotency: skip messages we've already imported. interactions.source
  // has no UNIQUE constraint, so we pre-filter by querying for the sources
  // we're about to write. One round trip beats N + duplicate rows.
  const candidateSources = messages.map((m) => `gmail:${m.id}`)
  const { data: existingRows } = await service
    .from('interactions')
    .select('source')
    .eq('user_id', user.id)
    .in('source', candidateSources)
  const alreadySynced = new Set(
    ((existingRows ?? []) as { source: string | null }[])
      .map((r) => r.source)
      .filter((s): s is string => typeof s === 'string'),
  )

  const reports: SyncReport[] = []
  let totalCommitments = 0

  for (const msg of messages) {
    try {
      if (alreadySynced.has(`gmail:${msg.id}`)) {
        reports.push({ message_id: msg.id, status: 'skipped', error: 'already_synced' })
        continue
      }

      const fromEmail = normalizeEmail(msg.from)
      const toList: string[] = Array.isArray(msg.to)
        ? msg.to.map(normalizeEmail)
        : msg.to
        ? [normalizeEmail(msg.to)]
        : []

      const userIsSender = userEmail && fromEmail === userEmail
      const counterpartyEmails = userIsSender
        ? toList.filter((e) => e && e !== userEmail)
        : [fromEmail].filter((e) => e && e !== userEmail)

      if (counterpartyEmails.length === 0) {
        reports.push({ message_id: msg.id, status: 'skipped', error: 'no_counterparty' })
        continue
      }

      // Find the first matching contact using case-insensitive email lookup
      let row: ContactRow | undefined

      for (const emailToMatch of counterpartyEmails) {
        const match = contactsByLowercaseEmail.get(emailToMatch)
        if (match) {
          row = match
          break
        }
      }

      if (!row) {
        reports.push({ message_id: msg.id, status: 'skipped', error: 'no_matching_contact' })
        continue
      }

      const contact = {
        id: row.id,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null,
        email: row.email,
        company: row.company,
      }

      const occurredAt = msg.date ? new Date(msg.date).toISOString() : new Date().toISOString()
      const direction: 'inbound' | 'outbound' = userIsSender ? 'outbound' : 'inbound'

      const signals = await extractCommitments(msg.body, contact)

      const summary = msg.subject?.trim() || signals.key_points[0] || null

      const { data: interactionRow, error: ixErr } = await service
        .from('interactions')
        .insert({
          user_id: user.id,
          contact_id: contact.id,
          channel: 'email',
          direction,
          type: 'email',
          summary,
          body: msg.body.slice(0, 20000),
          sentiment: signals.sentiment,
          key_points: signals.key_points,
          action_items: signals.action_items.map((d) => ({ description: d, owner: 'me' })),
          source: `gmail:${msg.id}`,
          occurred_at: occurredAt,
        })
        .select('id')
        .single()

      if (ixErr || !interactionRow) {
        reports.push({ message_id: msg.id, status: 'error', error: ixErr?.message ?? 'insert_failed' })
        continue
      }

      const commitmentRows = signals.commitments.map((c) => ({
        user_id: user.id,
        contact_id: contact.id,
        interaction_id: interactionRow.id,
        description: c.description,
        due_at: c.due_at,
        owner: ownerToDb(c.owner),
        // commitments.direction is NOT NULL in prod; mirror owner.
        direction: ownerToDb(c.owner),
        status: 'open' as const,
      }))

      let commitmentsInserted = 0
      if (commitmentRows.length > 0) {
        const { error: cmtErr } = await service
          .from('commitments')
          .insert(commitmentRows)
        if (cmtErr) {
          console.warn('[gmail-sync] commitments insert failed', {
            message_id: msg.id,
            count: commitmentRows.length,
            message: cmtErr.message,
          })
        } else {
          commitmentsInserted = commitmentRows.length
        }
      }

      // Schema-grounded merge: fold this email's signals into the contact's
      // structured personal_details. We use the latest in-memory copy so
      // multiple messages for the same contact in one batch accumulate.
      const latestRow = contactsById.get(row.id) ?? row
      const mergedDetails = mergeSignalsIntoDetails(
        latestRow.personal_details,
        signals,
        {
          occurredAt,
          channel: 'email',
          direction,
        },
      )

      await service
        .from('contacts')
        .update({
          personal_details: mergedDetails,
          last_interaction_at: occurredAt,
        })
        .eq('id', row.id)
        .eq('user_id', user.id)

      contactsById.set(row.id, { ...latestRow, personal_details: mergedDetails })

      totalCommitments += commitmentsInserted
      reports.push({
        message_id: msg.id,
        status: 'processed',
        contact_id: contact.id,
        commitments_created: commitmentsInserted,
      })
    } catch (err) {
      reports.push({
        message_id: msg.id,
        status: 'error',
        error: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  const errorReports = reports.filter((r) => r.status === 'error')
  const sampleErrors = Array.from(
    new Set(errorReports.map((r) => r.error ?? 'unknown')),
  ).slice(0, 3)

  return NextResponse.json({
    processed: reports.filter((r) => r.status === 'processed').length,
    skipped: reports.filter((r) => r.status === 'skipped').length,
    errors: errorReports.length,
    commitments_created: totalCommitments,
    sample_errors: sampleErrors,
    results: reports,
  })
}
