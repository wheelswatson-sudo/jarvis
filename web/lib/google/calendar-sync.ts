// Pulls Google Calendar events for a user and persists them to the
// `calendar_events` table. Used by both the on-demand sync route and the
// daily cron. Caller resolves the Google OAuth client; this module owns the
// fetch loop, the row mapping, and the upsert.
//
// Dedup happens at the DB layer via the unique index on
// (user_id, source, external_id) — we use upsert with onConflict so a
// re-sync over an overlapping window updates rows in place.

import { google, type calendar_v3 } from 'googleapis'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildOAuthClient } from './oauth'

const SOURCE = 'google_calendar'

export type CalendarSyncOptions = {
  /** Days into the past to include. Defaults to 1 — yesterday + today. */
  pastDays?: number
  /** Days into the future to include. Defaults to 14. */
  futureDays?: number
  /** Calendar id. Defaults to 'primary'. */
  calendarId?: string
  /** Hard cap on events fetched per run. Defaults to 250. */
  maxResults?: number
}

export type CalendarSyncResult = {
  fetched: number
  upserted: number
  skipped: number
  errors: number
  range: { from: string; to: string }
}

type AttendeeRow = {
  email: string | null
  name: string | null
  response: string | null
  organizer: boolean
}

/**
 * Fetch a window of Google Calendar events for `userId` using `accessToken`
 * and persist them via the service-role client. Returns a small report.
 */
export async function syncCalendarForUser(
  service: SupabaseClient,
  userId: string,
  accessToken: string,
  opts: CalendarSyncOptions = {},
): Promise<CalendarSyncResult> {
  const calendarId = opts.calendarId ?? 'primary'
  const pastDays = clampInt(opts.pastDays, 0, 30, 1)
  const futureDays = clampInt(opts.futureDays, 1, 90, 14)
  const maxResults = clampInt(opts.maxResults, 1, 2500, 250)

  const timeMin = new Date(Date.now() - pastDays * 24 * 60 * 60 * 1000)
  const timeMax = new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000)

  const calendar = google.calendar({
    version: 'v3',
    auth: buildOAuthClient(accessToken),
  })

  const events: calendar_v3.Schema$Event[] = []
  let pageToken: string | undefined
  let pageCount = 0
  // Cap pages defensively in case Google returns very small pages.
  while (pageCount < 10) {
    const res = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: Math.min(250, maxResults - events.length),
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
    })
    events.push(...(res.data.items ?? []))
    pageToken = res.data.nextPageToken ?? undefined
    pageCount++
    if (!pageToken || events.length >= maxResults) break
  }

  // Pre-fetch the user's contacts so we can join attendee emails to
  // contact_id at insert time. Calendar attendees that don't match a
  // contact still get persisted with contact_id=null.
  const { data: contactRows } = await service
    .from('contacts')
    .select('id, email')
    .eq('user_id', userId)
    .not('email', 'is', null)
    .limit(5000)

  const emailToContactId = new Map<string, string>()
  for (const c of (contactRows ?? []) as { id: string; email: string | null }[]) {
    if (c.email) emailToContactId.set(c.email.toLowerCase().trim(), c.id)
  }

  const userEmail = await lookupUserEmail(service, userId)

  let upserted = 0
  let skipped = 0
  let errors = 0

  for (const e of events) {
    if (!e.id) {
      skipped++
      continue
    }
    if (e.status === 'cancelled') {
      // Honor cancellations — drop the row if it exists, then move on.
      await service
        .from('calendar_events')
        .delete()
        .eq('user_id', userId)
        .eq('source', SOURCE)
        .eq('external_id', e.id)
      skipped++
      continue
    }

    const startAt = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null)
    if (!startAt) {
      skipped++
      continue
    }
    const endAt = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null)
    const isAllDay = !e.start?.dateTime && !!e.start?.date

    const attendees: AttendeeRow[] =
      e.attendees?.map((a) => ({
        email: a.email ?? null,
        name: a.displayName ?? null,
        response: a.responseStatus ?? null,
        organizer: a.organizer === true,
      })) ?? []

    const contactId = pickContactId(attendees, emailToContactId, userEmail)

    const conferenceUrl =
      e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')
        ?.uri ?? null

    const row = {
      user_id: userId,
      external_id: e.id,
      calendar_id: calendarId,
      title: e.summary ?? null,
      description: e.description ?? null,
      location: e.location ?? null,
      start_at: startAt,
      end_at: endAt,
      is_all_day: isAllDay,
      attendees: attendees as unknown as object,
      organizer: e.organizer
        ? { email: e.organizer.email ?? null, name: e.organizer.displayName ?? null }
        : null,
      conference_url: conferenceUrl,
      html_link: e.htmlLink ?? null,
      status: e.status ?? null,
      contact_id: contactId,
      source: SOURCE,
    }

    const { error } = await service
      .from('calendar_events')
      .upsert(row, { onConflict: 'user_id,source,external_id' })
    if (error) {
      errors++
      console.warn('[calendar-sync] upsert failed', {
        external_id: e.id,
        message: error.message,
      })
    } else {
      upserted++
    }
  }

  return {
    fetched: events.length,
    upserted,
    skipped,
    errors,
    range: { from: timeMin.toISOString(), to: timeMax.toISOString() },
  }
}

function pickContactId(
  attendees: AttendeeRow[],
  emailToContactId: Map<string, string>,
  userEmail: string | null,
): string | null {
  // Prefer the first non-self attendee that matches a known contact.
  for (const a of attendees) {
    const email = a.email?.toLowerCase().trim()
    if (!email) continue
    if (userEmail && email === userEmail) continue
    const cid = emailToContactId.get(email)
    if (cid) return cid
  }
  return null
}

async function lookupUserEmail(
  service: SupabaseClient,
  userId: string,
): Promise<string | null> {
  // Check the integration row first — that's where we store the connected
  // Google account email. Fall back to auth.users via the admin API.
  const { data } = await service
    .from('user_integrations')
    .select('account_email')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()
  const email = (data as { account_email: string | null } | null)?.account_email
  return email ? email.toLowerCase().trim() : null
}

function clampInt(
  raw: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}
