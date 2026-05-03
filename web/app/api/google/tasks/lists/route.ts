import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { createClient } from '../../../../../lib/supabase/server'
import { apiError } from '../../../../../lib/api-errors'
import {
  buildOAuthClient,
  getValidAccessTokenForUser,
  googleApiError,
} from '../../../../../lib/google/oauth'

export const dynamic = 'force-dynamic'

// GET /api/google/tasks/lists
//
// Returns the user's tasklists so the EA / UI can pick which one to read or
// write. Authentication is automatic via the persisted refresh token.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error

  const tasks = google.tasks({ version: 'v1', auth: buildOAuthClient(tok.token) })

  try {
    const res = await tasks.tasklists.list({ maxResults: 100 })
    const items = res.data.items ?? []
    return NextResponse.json({
      tasklists: items.map((l) => ({
        id: l.id,
        title: l.title ?? null,
        updated: l.updated ?? null,
      })),
    })
  } catch (err) {
    return googleApiError(err)
  }
}
