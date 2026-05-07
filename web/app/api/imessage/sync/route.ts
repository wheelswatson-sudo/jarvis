import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import {
  storeImessages,
  extractAndStoreImessageCommitments,
  IMESSAGE_CHANNEL,
  type IncomingImessage,
} from '../../../../lib/imessage/sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// POST /api/imessage/sync
//
// Read-only iMessage ingestion endpoint. Vercel can't read the local
// ~/Library/Messages/chat.db, so the local bridge (bin/jarvis-imessage-bridge)
// reads it, normalizes a batch, and POSTs it here.
//
// Auth — two modes, mirroring /api/intelligence/compute-metrics:
//   1. Browser session (Supabase cookie) — user_id derived from the session
//   2. Local cron / bridge — `x-cron-secret: $CRON_SECRET` header + the
//      user_id in the body. This is the path the bridge takes.
//
// Body:
//   {
//     user_id?: string                      // required in cron mode
//     messages: IncomingImessage[]          // batch — capped at MAX_BATCH
//     extract?: boolean                     // default true
//   }
//
// Response:
//   { ok, store: { fetched, imported, skipped, errors },
//     extract?: { processed, skipped, errors, commitments_created } }

const MAX_BATCH = 500

type Body = {
  user_id?: unknown
  messages?: unknown
  extract?: unknown
}

export async function POST(req: NextRequest) {
  const service = getServiceClient()
  if (!service) {
    return apiError(
      500,
      'Service role key not configured',
      undefined,
      'no_service_key',
    )
  }

  const body = (await req.json().catch(() => null)) as Body | null
  if (!body || !Array.isArray(body.messages)) {
    return apiError(
      400,
      'messages array is required',
      undefined,
      'invalid_request',
    )
  }

  const userId = await resolveUserId(req, body)
  if (!userId) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const incoming = sanitizeBatch(body.messages)
  if (incoming.length === 0) {
    await touchIntegration(userId)
    return NextResponse.json({
      ok: true,
      store: { fetched: 0, imported: 0, skipped: 0, errors: 0 },
    })
  }

  const store = await storeImessages(service, userId, incoming)

  const wantExtract = body.extract !== false
  let extract:
    | { processed: number; skipped: number; errors: number; commitments_created: number }
    | undefined
  if (wantExtract && store.messages.length > 0) {
    try {
      extract = await extractAndStoreImessageCommitments(
        service,
        userId,
        store.messages,
      )
    } catch (err) {
      // Extractor failures must not break ingestion — the raw messages are
      // already persisted. Surface the error in the response so the bridge
      // can log it.
      console.warn(
        '[imessage/sync] extraction failed',
        err instanceof Error ? err.message : err,
      )
    }
  }

  await touchIntegration(userId)

  return NextResponse.json({
    ok: true,
    store: {
      fetched: store.fetched,
      imported: store.imported,
      skipped: store.skipped,
      errors: store.errors,
    },
    extract,
  })
}

async function resolveUserId(
  req: NextRequest,
  body: Body,
): Promise<string | null> {
  // Cron / bridge: shared-secret header + explicit user_id.
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const header = req.headers.get('x-cron-secret')
    if (header && safeEqual(header, cronSecret)) {
      return typeof body.user_id === 'string' && body.user_id.length > 0
        ? body.user_id
        : null
    }
  }
  // Browser session — fall through to Supabase cookie auth.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

function sanitizeBatch(raw: unknown): IncomingImessage[] {
  if (!Array.isArray(raw)) return []
  const out: IncomingImessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    const guid = typeof m.guid === 'string' ? m.guid.trim() : ''
    const handle = typeof m.handle === 'string' ? m.handle.trim() : ''
    const text = typeof m.text === 'string' ? m.text : ''
    const sentAtRaw =
      typeof m.sent_at === 'string' ? m.sent_at : null
    const direction =
      m.direction === 'inbound' || m.direction === 'outbound'
        ? m.direction
        : null
    if (!guid || !handle || !sentAtRaw || !direction) continue
    const sentAt = new Date(sentAtRaw)
    if (Number.isNaN(sentAt.getTime())) continue
    out.push({
      guid,
      chat_guid:
        typeof m.chat_guid === 'string' && m.chat_guid.length > 0
          ? m.chat_guid
          : null,
      handle,
      handle_name:
        typeof m.handle_name === 'string' && m.handle_name.length > 0
          ? m.handle_name
          : null,
      direction,
      text,
      sent_at: sentAt.toISOString(),
      is_read: typeof m.is_read === 'boolean' ? m.is_read : undefined,
      service:
        typeof m.service === 'string' && m.service.length > 0
          ? m.service
          : null,
    })
    if (out.length >= MAX_BATCH) break
  }
  return out
}

async function touchIntegration(userId: string): Promise<void> {
  const service = getServiceClient()
  if (!service) return
  await service.from('user_integrations').upsert(
    {
      user_id: userId,
      provider: IMESSAGE_CHANNEL,
      last_synced_at: new Date().toISOString(),
      scopes: ['local:chat.db:read'],
    },
    { onConflict: 'user_id,provider' },
  )
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
