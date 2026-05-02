import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import {
  extractCommitments,
  type ExtractedCommitment,
} from '../../../../lib/intelligence/extract-commitments'

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

  const reports: SyncReport[] = []
  let totalCommitments = 0

  for (const msg of messages) {
    try {
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

      const { data: contactRows } = await service
        .from('contacts')
        .select('id, name, email, company')
        .eq('user_id', user.id)
        .in('email', counterpartyEmails)
        .limit(5)

      const contact = (contactRows ?? [])[0] as
        | { id: string; name: string | null; email: string | null; company: string | null }
        | undefined

      if (!contact) {
        reports.push({ message_id: msg.id, status: 'skipped', error: 'no_matching_contact' })
        continue
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
        status: 'open' as const,
      }))

      if (commitmentRows.length > 0) {
        await service.from('commitments').insert(commitmentRows)
      }

      totalCommitments += commitmentRows.length
      reports.push({
        message_id: msg.id,
        status: 'processed',
        contact_id: contact.id,
        commitments_created: commitmentRows.length,
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
