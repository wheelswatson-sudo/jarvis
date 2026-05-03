import { NextResponse, type NextRequest } from 'next/server'
import { google, type gmail_v1 } from 'googleapis'
import { createClient } from '../../../../../lib/supabase/server'
import { getServiceClient } from '../../../../../lib/supabase/service'
import { apiError } from '../../../../../lib/api-errors'
import {
  buildOAuthClient,
  getValidAccessTokenForUser,
  googleApiError,
} from '../../../../../lib/google/oauth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/google/gmail/sync
//
// Pulls recent Gmail messages using the persisted Google access token
// (refreshing silently if it's expired) and inserts them into the unified
// `messages` table. Optionally accepts { days, max, query } to tune the
// fetch.
//
// This is the "automatic auth" replacement for the old client-driven flow
// where GmailSyncCard read session.provider_token and called Gmail directly.
// With persistent tokens the client just hits this endpoint — no token
// handling on the browser at all.

// Default filter — strip the obvious automated senders so the unified inbox
// stays focused on real contact conversations. Callers can override by
// passing `query` in the body.
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

function buildGmailQuery(days: number, override?: string | null): string {
  const trimmed = override?.trim()
  if (trimmed) return trimmed
  return [`newer_than:${days}d`, ...DEFAULT_FILTER_TOKENS].join(' ')
}

type GmailMessage = {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  body: string
  date: string
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

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service key not configured', undefined, 'no_service_key')
  }

  const body = (await req.json().catch(() => null)) as
    | { days?: number; max?: number; query?: string }
    | null
  const days = clampInt(body?.days, 1, 365, 90)
  const max = clampInt(body?.max, 1, 100, 25)
  const query = buildGmailQuery(days, body?.query ?? null)

  // Resolve a valid access token (refresh silently if needed).
  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error

  const gmail = google.gmail({ version: 'v1', auth: buildOAuthClient(tok.token) })

  // 1. List recent message ids.
  let ids: string[]
  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: max,
      q: query,
    })
    ids = (listRes.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
  } catch (err) {
    return googleApiError(err)
  }

  if (ids.length === 0) {
    await touchGmailIntegration(user.id)
    return NextResponse.json({
      ok: true,
      fetched: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
    })
  }

  // 2. Fetch each message's headers + body in parallel.
  const fetched = await Promise.all(
    ids.map(async (id): Promise<GmailMessage | null> => {
      try {
        const r = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'full',
        })
        const headers = r.data.payload?.headers ?? []
        const text = decodeBody(r.data.payload as gmail_v1.Schema$MessagePart | undefined)
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
  const messages = fetched.filter((m): m is GmailMessage => m !== null)

  // 3. Build email→contact_id lookup so messages join to contacts.
  const userEmail = (user.email ?? '').toLowerCase()
  const { data: contacts } = await service
    .from('contacts')
    .select('id, email')
    .eq('user_id', user.id)
    .not('email', 'is', null)
    .limit(5000)
  const emailToContactId = new Map<string, string>()
  for (const c of contacts ?? []) {
    if (c.email) emailToContactId.set(c.email.toLowerCase().trim(), c.id)
  }

  // 4. Upsert into the unified messages table.
  let imported = 0
  let skipped = 0
  let errors = 0
  for (const msg of messages) {
    const fromEmail = normalizeEmail(msg.from)
    const toEmail = normalizeEmail(msg.to)
    const isInbound = fromEmail !== userEmail
    const otherEmail = isInbound ? fromEmail : toEmail
    const contactId = emailToContactId.get(otherEmail) ?? null

    const row = {
      user_id: user.id,
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
        console.warn('[gmail-sync] insert error:', error.message)
      }
    } else {
      imported++
    }
  }

  // 5. Kick the commitment-extractor with the same payload (fire and
  //    forget — the client doesn't need to wait for AI extraction to
  //    show its inbox, and the extractor has its own dedup via the
  //    interactions.source check).
  let commitments_created: number | null = null
  let commitment_errors = 0
  try {
    const origin = new URL(req.url).origin
    const cookieHeader = req.headers.get('cookie') ?? ''
    const extractRes = await fetch(`${origin}/api/gmail/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieHeader,
      },
      body: JSON.stringify({ messages }),
    })
    if (extractRes.ok) {
      const extractData = (await extractRes.json().catch(() => ({}))) as {
        commitments_created?: number
        errors?: number
      }
      commitments_created = extractData.commitments_created ?? 0
      commitment_errors = extractData.errors ?? 0
    }
  } catch (err) {
    console.warn('[gmail-sync] extractor call failed', err)
  }

  await touchGmailIntegration(user.id)

  return NextResponse.json({
    ok: true,
    fetched: messages.length,
    imported,
    skipped,
    errors,
    commitments_created,
    commitment_errors,
  })
}

function clampInt(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

async function touchGmailIntegration(userId: string): Promise<void> {
  const service = getServiceClient()
  if (!service) return
  await service.from('user_integrations').upsert(
    {
      user_id: userId,
      provider: 'google_gmail',
      last_synced_at: new Date().toISOString(),
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    },
    { onConflict: 'user_id,provider' },
  )
}
