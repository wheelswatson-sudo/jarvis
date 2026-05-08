import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { getValidAccessTokenForUser } from '../../../../lib/google/oauth'
import { fetchAndStoreGmail } from '../../../../lib/google/gmail-sync'
import { syncCalendarForUser } from '../../../../lib/google/calendar-sync'
import { syncTasksForUser } from '../../../../lib/google/tasks-sync'
import { syncGoogleContactsForUser } from '../../../../lib/google/contacts-sync'

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
//   - Race-narrowing: we eagerly write `last_synced_at` on the 'google'
//     row BEFORE the fan-out begins, so a second tab opened a few seconds
//     later sees the throttle even while Gmail is still streaming. The
//     window between the SELECT throttle check and the eager-claim upsert
//     is ~10ms, which is good enough for multi-tab UX.
export async function POST() {
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

  // Eager throttle claim. Marking the 'google' row's last_synced_at NOW
  // (before any of the four legs touch Google) means a second tab opened
  // mid-fan-out sees the throttle and bails. Without this, multi-tab login
  // races through the SELECT-only check while syncs are still in flight.
  await service.from('user_integrations').upsert(
    {
      user_id: user.id,
      provider: 'google',
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  )

  const accessToken = tok.token
  const userEmail = (user.email ?? '').toLowerCase()

  // Run all four in parallel. Each leg is wrapped so a thrown error becomes
  // a structured failure for that service rather than rejecting the whole
  // batch.
  const [gmailRes, calendarRes, tasksRes, contactsRes] = await Promise.allSettled([
    runGmail(service, user.id, userEmail, accessToken),
    runCalendar(service, user.id, accessToken),
    runTasks(service, user.id, accessToken),
    runContacts(service, user.id, accessToken),
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
  service: SupabaseClient,
  userId: string,
  userEmail: string,
  accessToken: string,
): Promise<ServiceResult> {
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
  service: SupabaseClient,
  userId: string,
  accessToken: string,
): Promise<ServiceResult> {
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
  service: SupabaseClient,
  userId: string,
  accessToken: string,
): Promise<ServiceResult> {
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

async function runContacts(
  service: SupabaseClient,
  userId: string,
  accessToken: string,
): Promise<ServiceResult> {
  const outcome = await syncGoogleContactsForUser(service, userId, accessToken)
  if (!outcome.ok) {
    return { ok: false, error: outcome.error.code }
  }
  return {
    ok: true,
    counts: {
      inserted: outcome.result.inserted,
      updated: outcome.result.updated,
      skipped: outcome.result.skipped,
      total_fetched: outcome.result.total_fetched,
    },
  }
}
