import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/inbox/sync-gmail
//
// Pulls recent Gmail messages and inserts them into the unified messages table.
// Matches each message to a contact by email address.
// Deduplicates via the (user_id, channel, external_id) unique constraint.

type GmailMessageInput = {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  body: string
  date: string
}

function normalizeEmail(s: string): string {
  const m = s.match(/<([^>]+)>/)
  return (m?.[1] ?? s).trim().toLowerCase()
}

function extractName(s: string): string {
  // "John Doe <john@example.com>" → "John Doe"
  const m = s.match(/^"?([^"<]+)"?\s*</)
  return m?.[1]?.trim() ?? s.split('@')[0]
}

function makeSnippet(body: string): string {
  // Strip HTML tags, collapse whitespace, truncate
  const clean = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, 140)
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) return apiError(500, 'Service key not configured', undefined, 'no_service_key')

  const body = await req.json().catch(() => null)
  const messages = (body?.messages ?? []) as GmailMessageInput[]

  if (messages.length === 0) {
    return NextResponse.json({ ok: true, imported: 0, skipped: 0 })
  }

  const userEmail = (user.email ?? '').toLowerCase()

  // Build email → contact_id lookup
  const { data: contacts } = await service
    .from('contacts')
    .select('id, email, phone')
    .eq('user_id', user.id)
    .not('email', 'is', null)
    .limit(5000)

  const emailToContactId = new Map<string, string>()
  for (const c of contacts ?? []) {
    if (c.email) emailToContactId.set(c.email.toLowerCase().trim(), c.id)
  }

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
      body: msg.body.slice(0, 20000),
      snippet: makeSnippet(msg.body),
      thread_id: msg.threadId || null,
      external_id: msg.id,
      is_read: true, // Emails from Gmail are already "read"
      sent_at: new Date(msg.date).toISOString(),
    }

    const { error } = await service
      .from('messages')
      .upsert(row, { onConflict: 'user_id,channel,external_id', ignoreDuplicates: true })

    if (error) {
      if (error.code === '23505') { // duplicate
        skipped++
      } else {
        errors++
        console.warn('[sync-gmail] insert error:', error.message)
      }
    } else {
      imported++
    }
  }

  // Record a "last synced" stamp for the unified Google Workspace card so
  // the Settings UI knows Gmail is connected and how recently it pulled.
  await service.from('user_integrations').upsert(
    {
      user_id: user.id,
      provider: 'google_gmail',
      last_synced_at: new Date().toISOString(),
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    },
    { onConflict: 'user_id,provider' },
  )

  return NextResponse.json({ ok: true, imported, skipped, errors })
}
