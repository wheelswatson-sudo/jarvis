import { NextResponse, type NextRequest } from 'next/server'
import { google } from 'googleapis'
import { createClient } from '../../../../../lib/supabase/server'
import { getServiceClient } from '../../../../../lib/supabase/service'
import { apiError } from '../../../../../lib/api-errors'
import {
  buildOAuthClient,
  getValidAccessTokenForUser,
  googleApiError,
} from '../../../../../lib/google/oauth'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const PROVIDER = 'google_calendar'

// ---------------------------------------------------------------------------
// GET /api/google/calendar/events?days=14&calendar_id=primary
//
// Lists upcoming events on the user's calendar. Defaults to the next 14 days
// on the primary calendar. Authentication is automatic via the persisted
// Google refresh token — no token in the request.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error

  const url = new URL(req.url)
  const calendarId = url.searchParams.get('calendar_id') ?? 'primary'
  const days = clampInt(url.searchParams.get('days'), 1, 90, 14)
  const maxResults = clampInt(url.searchParams.get('max_results'), 1, 250, 50)

  const timeMin = new Date()
  const timeMax = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

  const calendar = google.calendar({ version: 'v3', auth: buildOAuthClient(tok.token) })

  let events
  try {
    const res = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    })
    events = res.data.items ?? []
  } catch (err) {
    return googleApiError(err)
  }

  void touchIntegration(user.id, [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ])

  return NextResponse.json({
    calendar_id: calendarId,
    range: { from: timeMin.toISOString(), to: timeMax.toISOString() },
    events: events.map((e) => ({
      id: e.id,
      summary: e.summary ?? null,
      description: e.description ?? null,
      location: e.location ?? null,
      start: e.start ?? null,
      end: e.end ?? null,
      attendees:
        e.attendees?.map((a) => ({
          email: a.email ?? null,
          name: a.displayName ?? null,
          response: a.responseStatus ?? null,
          organizer: a.organizer ?? false,
        })) ?? [],
      organizer: e.organizer
        ? { email: e.organizer.email ?? null, name: e.organizer.displayName ?? null }
        : null,
      conference:
        e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')
          ?.uri ?? null,
      html_link: e.htmlLink ?? null,
      status: e.status ?? null,
    })),
  })
}

// ---------------------------------------------------------------------------
// POST /api/google/calendar/events
//
// Body:
//   {
//     calendar_id?: string,
//     summary: string,
//     description?: string,
//     location?: string,
//     start: string (ISO),
//     end:   string (ISO),
//     timezone?: string,
//     attendees?: { email: string, name?: string }[],
//     send_updates?: 'all' | 'externalOnly' | 'none',
//     conference?: boolean,            // true → request a Meet link
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

  const summary = strField(body.summary)
  const start = strField(body.start)
  const end = strField(body.end)
  if (!summary || !start || !end) {
    return apiError(
      400,
      'summary, start, and end are required.',
      undefined,
      'invalid_request',
    )
  }

  const calendarId = strField(body.calendar_id) ?? 'primary'
  const description = strField(body.description) ?? undefined
  const location = strField(body.location) ?? undefined
  const timezone = strField(body.timezone) ?? undefined
  const sendUpdates = strField(body.send_updates) ?? 'none'
  const wantsConference = body.conference === true

  type Attendee = { email: string; displayName?: string }
  const attendeesRaw = Array.isArray(body.attendees) ? body.attendees : []
  const attendees: Attendee[] = []
  for (const a of attendeesRaw) {
    if (typeof a !== 'object' || a === null) continue
    const ax = a as Record<string, unknown>
    const email = strField(ax.email)
    if (!email) continue
    const name = strField(ax.name)
    attendees.push(name ? { email, displayName: name } : { email })
  }

  const calendar = google.calendar({ version: 'v3', auth: buildOAuthClient(tok.token) })

  let created
  try {
    const res = await calendar.events.insert({
      calendarId,
      sendUpdates: sendUpdates as 'all' | 'externalOnly' | 'none',
      conferenceDataVersion: wantsConference ? 1 : 0,
      requestBody: {
        summary,
        description,
        location,
        start: { dateTime: start, timeZone: timezone },
        end: { dateTime: end, timeZone: timezone },
        attendees: attendees.length > 0 ? attendees : undefined,
        conferenceData: wantsConference
          ? {
              createRequest: {
                requestId: `rid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            }
          : undefined,
      },
    })
    created = res.data
  } catch (err) {
    return googleApiError(err)
  }

  void touchIntegration(user.id, [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ])

  return NextResponse.json({
    id: created.id,
    html_link: created.htmlLink ?? null,
    conference:
      created.conferenceData?.entryPoints?.find(
        (p: { entryPointType?: string | null }) => p.entryPointType === 'video',
      )?.uri ?? null,
    status: created.status ?? null,
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

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

async function touchIntegration(userId: string, scopes: string[]): Promise<void> {
  const service = getServiceClient()
  if (!service) return
  await service.from('user_integrations').upsert(
    {
      user_id: userId,
      provider: PROVIDER,
      last_synced_at: new Date().toISOString(),
      scopes,
    },
    { onConflict: 'user_id,provider' },
  )
}
