import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'
import { getServiceClient } from '../../../../../lib/supabase/service'
import { apiError } from '../../../../../lib/api-errors'
import {
  getValidAccessTokenForUser,
  googleApiError,
} from '../../../../../lib/google/oauth'
import { syncTasksForUser } from '../../../../../lib/google/tasks-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PROVIDER = 'google_tasks'
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks'

// POST /api/google/tasks/sync
//
// Pulls Google Tasks for the authenticated user and mirrors them into the
// commitments table. Idempotent — re-syncing updates existing rows by
// (source, external_id). Body is optional:
//   { tasklist?: string, include_completed?: boolean }
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service key not configured', undefined, 'no_service_key')
  }

  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error

  const body = (await req.json().catch(() => null)) as
    | { tasklist?: string; include_completed?: boolean }
    | null

  let result
  try {
    result = await syncTasksForUser(service, user.id, tok.token, {
      tasklist: body?.tasklist,
      includeCompleted: body?.include_completed,
    })
  } catch (err) {
    return googleApiError(err)
  }

  await service.from('user_integrations').upsert(
    {
      user_id: user.id,
      provider: PROVIDER,
      last_synced_at: new Date().toISOString(),
      scopes: [TASKS_SCOPE],
    },
    { onConflict: 'user_id,provider' },
  )

  return NextResponse.json({ ok: true, ...result })
}
