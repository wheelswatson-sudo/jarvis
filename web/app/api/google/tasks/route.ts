import { NextResponse, type NextRequest } from 'next/server'
import { google } from 'googleapis'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import {
  buildOAuthClient,
  getValidAccessTokenForUser,
  googleApiError,
} from '../../../../lib/google/oauth'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const PROVIDER = 'google_tasks'
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks'

// ---------------------------------------------------------------------------
// GET /api/google/tasks?tasklist=@default&show_completed=false
//
// Lists tasks on a tasklist (defaults to the user's default list).
// Authentication is automatic via the persisted refresh token.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error

  const url = new URL(req.url)
  const tasklist = url.searchParams.get('tasklist') ?? '@default'
  const showCompleted = url.searchParams.get('show_completed') === 'true'

  const tasks = google.tasks({ version: 'v1', auth: buildOAuthClient(tok.token) })

  let items
  try {
    const res = await tasks.tasks.list({
      tasklist,
      showCompleted,
      showHidden: false,
      maxResults: 100,
    })
    items = res.data.items ?? []
  } catch (err) {
    return googleApiError(err)
  }

  void touchIntegration(user.id)

  return NextResponse.json({
    tasklist,
    tasks: items.map((t) => ({
      id: t.id,
      title: t.title ?? null,
      notes: t.notes ?? null,
      status: t.status ?? null,
      due: t.due ?? null,
      completed: t.completed ?? null,
      parent: t.parent ?? null,
      position: t.position ?? null,
    })),
  })
}

// ---------------------------------------------------------------------------
// POST /api/google/tasks
//
// Body:
//   {
//     tasklist?: string,        // defaults to '@default'
//     title: string,
//     notes?: string,
//     due?: string (RFC 3339),  // Google Tasks ignores time-of-day, only date.
//   }
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error

  const body =
    ((await req.json().catch(() => null)) as Record<string, unknown> | null) ??
    {}
  const title = strField(body.title)
  if (!title) {
    return apiError(400, 'title is required.', undefined, 'invalid_request')
  }
  const tasklist = strField(body.tasklist) ?? '@default'
  const notes = strField(body.notes) ?? undefined
  const due = strField(body.due) ?? undefined

  const tasks = google.tasks({ version: 'v1', auth: buildOAuthClient(tok.token) })

  let created
  try {
    const res = await tasks.tasks.insert({
      tasklist,
      requestBody: { title, notes, due },
    })
    created = res.data
  } catch (err) {
    return googleApiError(err)
  }

  void touchIntegration(user.id)

  return NextResponse.json({
    id: created.id,
    title: created.title ?? null,
    status: created.status ?? null,
    due: created.due ?? null,
  })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function strField(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length === 0 ? null : t
}

async function touchIntegration(userId: string): Promise<void> {
  const service = getServiceClient()
  if (!service) return
  await service.from('user_integrations').upsert(
    {
      user_id: userId,
      provider: PROVIDER,
      last_synced_at: new Date().toISOString(),
      scopes: [TASKS_SCOPE],
    },
    { onConflict: 'user_id,provider' },
  )
}
