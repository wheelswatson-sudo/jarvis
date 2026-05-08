import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { getValidAccessTokenForUser } from '../../../../lib/google/oauth'
import { fetchAndStoreGmail } from '../../../../lib/google/gmail-sync'
import { syncCalendarForUser } from '../../../../lib/google/calendar-sync'
import { syncTasksForUser } from '../../../../lib/google/tasks-sync'

export const dynamic = 'force-dynamic'
// Worst case: contacts (~30s on a large book) + gmail extractor (~60s) +
// calendar/tasks (~10s each) running in parallel. Match the heaviest leg.
export const maxDuration = 120

// Throttle window — don't re-fan-out if the user just did this. Refreshing
// the dashboard or bouncing across tabs in the same session shouldn't
// re-sync four Google APIs every time.
const THROTTLE_MS = 5 * 60 * 1000

type ServiceResult =
  | { ok: true; skipped?: false; counts?: Record<string, number | null> }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; error: string }

type AutoSyncResponse = {
  ok: true
  throttled: boolean
  account_email: string | null
  services: {
    gmail: ServiceResult
    calendar: ServiceResult
    tasks: ServiceResult
    contacts: ServiceResult
  }
}

// POST /api/google/auto-sync
//
// Single-shot fan-out that runs Gmail + Calendar + Tasks + Contacts syncs in
// parallel. Designed to be called by the client right after the user lands
// on the app while authenticated, so first-time and returning users see
// fresh data without touching the Settings panel.
//
// Behaviour:
//   - 401 if there's no Supabase session.
//   - If the user has never connected Google (no refresh token persisted),
//     every service returns `{ ok: false, skipped: true, reason: 'not_connected' }`
//     and the route still returns 200. The caller treats this as a no-op.
//   - If anything synced inside the last THROTTLE_MS, we short-circuit and
//     return `{ throttled: true }`. The client uses sessionStorage on top of
//     this for an additional first-mount-only guard.
//   - Per-service failures don't poison the whole response — Promise.allSettled
//     so a Gmail outage still lets Calendar/Tasks/Contacts proceed.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service key not configured', undefined, 'no_service_key')
  }

  // Connection check first — if Google isn't connected, return cleanly with
  // every service marked skipped so the client can hide its toast.
  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) {
    const skipped: ServiceResult = {
      ok: false,
      skipped: true,
      reason: 'not_connected',
    }
    const body: AutoSyncResponse = {
      ok: true,
      throttled: false,
      account_email: null,
      services: {
        gmail: skipped,
        calendar: skipped,
        tasks: skipped,
        contacts: skipped,
      },
    }
    return NextResponse.json(body)
  }

  // Throttle: look at last_synced_at across the four service rows. If any
  // of them sync'd inside the window, we assume auto-sync already ran for
  // this user and bail out cheaply.
  const { data: recentRows } = await service
    .from('user_integrations')
    .select('provider, last_synced_at')
    .eq('user_id', user.id)
    .in('provider', [
      'google',
      'google_calendar',
      'google_tasks',
      'google_contacts',
    ])

  const now = Date.now()
  const recentlySynced = (recentRows ?? []).some((row) => {
    const ts = row.last_synced_at ? Date.parse(row.last_synced_at) : 0
    return Number.isFinite(ts) && now - ts < THROTTLE_MS
  })

  if (recentlySynced) {
    const skip: ServiceResult = {
      ok: false,
      skipped: true,
      reason: 'recently_synced',
    }
    const body: AutoSyncResponse = {
      ok: true,
      throttled: true,
      account_email: user.email ?? null,
      services: {
        gmail: skip,
        calendar: skip,
        tasks: skip,
        contacts: skip,
      },
    }
    return NextResponse.json(body)
  }

  const accessToken = tok.token
  const userEmail = (user.email ?? '').toLowerCase()
  const origin = new URL(req.url).origin
  const cookieHeader = req.headers.get('cookie') ?? ''

  // Run all four in parallel. Each leg is wrapped so a thrown error becomes
  // a structured failure for that service rather than rejecting the whole
  // batch.
  const [gmailRes, calendarRes, tasksRes, contactsRes] = await Promise.allSettled([
    runGmail(service, user.id, userEmail, accessToken),
    runCalendar(service, user.id, accessToken),
    runTasks(service, user.id, accessToken),
    // Contacts logic still lives inside its route handler, so we re-enter
    // through HTTP with the user's cookie forwarded. Same origin → no SSRF.
    runContactsViaHttp(origin, cookieHeader),
  ])

  const body: AutoSyncResponse = {
    ok: true,
    throttled: false,
    account_email: user.email ?? null,
    services: {
      gmail: settledToService(gmailRes),
      calendar: settledToService(calendarRes),
      tasks: settledToService(tasksRes),
      contacts: settledToService(contactsRes),
    },
  }
  return NextResponse.json(body)
}

function settledToService(
  s: PromiseSettledResult<ServiceResult>,
): ServiceResult {
  if (s.status === 'fulfilled') return s.value
  const message =
    s.reason instanceof Error ? s.reason.message : String(s.reason ?? 'error')
  return { ok: false, error: message }
}

async function runGmail(
  service: ReturnType<typeof getServiceClient>,
  userId: string,
  userEmail: string,
  accessToken: string,
): Promise<ServiceResult> {
  if (!service) return { ok: false, error: 'no_service_key' }
  const store = await fetchAndStoreGmail(service, userId, userEmail, accessToken)
  await service.from('user_integrations').upsert(
    {
      user_id: userId,
      provider: 'google',
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  )
  return {
    ok: true,
    counts: {
      fetched: store.fetched,
      imported: store.imported,
      skipped: store.skipped,
      errors: store.errors,
    },
  }
}

async function runCalendar(
  service: ReturnType<typeof getServiceClient>,
  userId: string,
  accessToken: string,
): Promise<ServiceResult> {
  if (!service) return { ok: false, error: 'no_service_key' }
  const result = await syncCalendarForUser(service, userId, accessToken)
  await service.from('user_integrations').upsert(
    {
      user_id: userId,
      provider: 'google_calendar',
      last_synced_at: new Date().toISOString(),
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events',
      ],
    },
    { onConflict: 'user_id,provider' },
  )
  return {
    ok: true,
    counts: {
      fetched: result.fetched ?? null,
      upserted: result.upserted ?? null,
      skipped: result.skipped ?? null,
    },
  }
}

async function runTasks(
  service: ReturnType<typeof getServiceClient>,
  userId: string,
  accessToken: string,
): Promise<ServiceResult> {
  if (!service) return { ok: false, error: 'no_service_key' }
  const result = await syncTasksForUser(service, userId, accessToken)
  await service.from('user_integrations').upsert(
    {
      user_id: userId,
      provider: 'google_tasks',
      last_synced_at: new Date().toISOString(),
      scopes: ['https://www.googleapis.com/auth/tasks'],
    },
    { onConflict: 'user_id,provider' },
  )
  // syncTasksForUser returns counts in a result-shape we don't care about
  // here; surface the keys we do recognise so the client can show numbers
  // if it ever wants to.
  const counts: Record<string, number | null> = {}
  if (result && typeof result === 'object') {
    for (const [k, v] of Object.entries(result)) {
      if (typeof v === 'number') counts[k] = v
    }
  }
  return { ok: true, counts }
}

async function runContactsViaHttp(
  origin: string,
  cookieHeader: string,
): Promise<ServiceResult> {
  const res = await fetch(`${origin}/api/contacts/google`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
    },
    body: '{}',
    cache: 'no-store',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: `contacts_http_${res.status}: ${text.slice(0, 200)}` }
  }
  const data = (await res.json().catch(() => null)) as
    | { inserted?: number; updated?: number; skipped?: number; total_fetched?: number }
    | null
  return {
    ok: true,
    counts: {
      inserted: data?.inserted ?? null,
      updated: data?.updated ?? null,
      skipped: data?.skipped ?? null,
      total_fetched: data?.total_fetched ?? null,
    },
  }
}
