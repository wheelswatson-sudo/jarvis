import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'
import { getServiceClient } from '../../../../../lib/supabase/service'
import { apiError } from '../../../../../lib/api-errors'
import {
  getValidAccessTokenForUser,
  googleApiError,
} from '../../../../../lib/google/oauth'
import {
  fetchAndStoreGmail,
  extractAndStoreCommitments,
} from '../../../../../lib/google/gmail-sync'

export const dynamic = 'force-dynamic'
// Inline extractor: 25 messages × ~1-3s/Groq call + Gmail fetches + DB
// upserts can creep toward 60s. Match imessage/sync's headroom.
export const maxDuration = 120

// POST /api/google/gmail/sync
//
// Browser-driven Gmail sync. Pulls recent messages with the persisted
// Google access token (silent refresh) and runs the commitment extractor
// in-process. Replaces the old client-driven flow that read
// session.provider_token directly — now the browser just hits this and
// the server owns token handling end-to-end.
//
// All real work is delegated to lib/google/gmail-sync.ts so the cron path
// (/api/cron/daily-sync) and this interactive path execute identical
// logic. Body is optional: { days?, max?, query? }.
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

  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error

  const userEmail = (user.email ?? '').toLowerCase()

  // 1. Fetch + persist messages.
  let store
  try {
    store = await fetchAndStoreGmail(service, user.id, userEmail, tok.token, {
      days: body?.days,
      max: body?.max,
      query: body?.query,
    })
  } catch (err) {
    return googleApiError(err)
  }

  // 2. Run the commitment extractor over the same payload. Failures here
  //    must not break ingestion — raw messages are already persisted.
  let commitments_created: number | null = null
  let commitment_errors = 0
  try {
    const extract = await extractAndStoreCommitments(
      service,
      user.id,
      userEmail,
      store.messages,
    )
    commitments_created = extract.commitments_created
    commitment_errors = extract.errors
  } catch (err) {
    console.warn(
      '[gmail-sync] extractor failed',
      err instanceof Error ? err.message : err,
    )
  }

  await touchGmailIntegration(user.id)

  return NextResponse.json({
    ok: true,
    fetched: store.fetched,
    imported: store.imported,
    skipped: store.skipped,
    errors: store.errors,
    commitments_created,
    commitment_errors,
  })
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
