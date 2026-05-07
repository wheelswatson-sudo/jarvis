// Loads upcoming meeting cards for the dashboard's "Today's meetings"
// section. Joins calendar_events to the user's contacts (via attendee
// emails), then enriches each match with the bits a pre-meeting brief
// needs: tier, last interaction, open commitments, relationship trend.
//
// Returns null when the user hasn't connected Google Calendar at all
// (no calendar_events rows ever) so the UI can render a connect-prompt
// instead of an empty list.

import type { SupabaseClient } from '@supabase/supabase-js'
import { contactName } from '../format'
import type { Tier } from '../types'

export type AttendeeBrief = {
  contact_id: string
  name: string
  tier: Tier | null
  last_interaction_at: string | null
  open_commitments: number
  trend: 'warming' | 'stable' | 'cooling' | 'dormant' | null
}

export type MeetingCard = {
  id: string
  title: string | null
  start_at: string
  end_at: string | null
  conference_url: string | null
  location: string | null
  attendees: AttendeeBrief[]
}

export type UpcomingMeetingsResult = {
  meetings: MeetingCard[]
  calendarConnected: boolean
}

type RawAttendee = {
  email?: string | null
  name?: string | null
  response?: string | null
  organizer?: boolean
}

const HOURS_24 = 24 * 60 * 60 * 1000

export async function loadUpcomingMeetings(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<UpcomingMeetingsResult> {
  const horizon = new Date(now.getTime() + HOURS_24)

  // Probe whether calendar has ever synced. We check for any row to
  // distinguish "no calendar connected" from "no meetings in the next 24h".
  const probe = await supabase
    .from('calendar_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .limit(1)

  if (probe.error) {
    // Probe failed (RLS, schema drift, transient) — log and treat as
    // not-connected so the UI shows the connect prompt rather than crashing.
    // The error is logged so we don't lose the breadcrumb.
    console.error('[upcoming-meetings] probe failed', probe.error)
    return { meetings: [], calendarConnected: false }
  }

  const calendarConnected = (probe.count ?? 0) > 0
  if (!calendarConnected) {
    return { meetings: [], calendarConnected: false }
  }

  const eventsRes = await supabase
    .from('calendar_events')
    .select(
      'id, title, start_at, end_at, conference_url, location, attendees',
    )
    .eq('user_id', userId)
    .gte('start_at', now.toISOString())
    .lte('start_at', horizon.toISOString())
    .order('start_at', { ascending: true })
    .limit(20)

  if (eventsRes.error) {
    console.error('[upcoming-meetings] events query failed', eventsRes.error)
    return { meetings: [], calendarConnected: true }
  }
  if (!eventsRes.data) {
    return { meetings: [], calendarConnected: true }
  }

  const events = eventsRes.data as {
    id: string
    title: string | null
    start_at: string
    end_at: string | null
    conference_url: string | null
    location: string | null
    attendees: unknown
  }[]

  if (events.length === 0) {
    return { meetings: [], calendarConnected: true }
  }

  // Collect every attendee email across all upcoming events so we can do
  // a single contacts lookup instead of N queries.
  const allEmails = new Set<string>()
  const byEvent: { ev: (typeof events)[number]; emails: string[] }[] = []
  for (const ev of events) {
    const arr = Array.isArray(ev.attendees) ? (ev.attendees as RawAttendee[]) : []
    // Defensive: only accept string emails. Malformed JSONB rows (e.g. an
    // attendee object whose `email` field is null or a number) are silently
    // skipped rather than throwing on `.toLowerCase`.
    const emails = arr
      .map((a) =>
        typeof a?.email === 'string' ? a.email.toLowerCase().trim() : '',
      )
      .filter((e): e is string => e.length > 0)
    for (const e of emails) allEmails.add(e)
    byEvent.push({ ev, emails })
  }

  if (allEmails.size === 0) {
    return {
      meetings: events.map((ev) => ({
        id: ev.id,
        title: ev.title,
        start_at: ev.start_at,
        end_at: ev.end_at,
        conference_url: ev.conference_url,
        location: ev.location,
        attendees: [],
      })),
      calendarConnected: true,
    }
  }

  const emailList = Array.from(allEmails)

  const [contactsRes, edgesRes, commitmentsRes] = await Promise.all([
    supabase
      .from('contacts')
      .select(
        'id, first_name, last_name, email, tier, last_interaction_at',
      )
      .eq('user_id', userId)
      .in('email', emailList),
    supabase
      .from('relationship_edges')
      .select('contact_id, trend')
      .eq('user_id', userId),
    supabase
      .from('commitments')
      .select('contact_id, status')
      .eq('user_id', userId)
      .eq('status', 'open'),
  ])

  if (contactsRes.error)
    console.error('[upcoming-meetings] contacts query failed', contactsRes.error)
  if (edgesRes.error)
    console.error('[upcoming-meetings] edges query failed', edgesRes.error)
  if (commitmentsRes.error)
    console.error(
      '[upcoming-meetings] commitments query failed',
      commitmentsRes.error,
    )

  type ContactRow = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    tier: Tier | null
    last_interaction_at: string | null
  }
  const contacts = (contactsRes.data ?? []) as ContactRow[]

  const emailToContact = new Map<string, ContactRow>()
  for (const c of contacts) {
    if (c.email) emailToContact.set(c.email.toLowerCase().trim(), c)
  }

  const trendByContact = new Map<string, AttendeeBrief['trend']>()
  for (const e of (edgesRes.data ?? []) as {
    contact_id: string
    trend: AttendeeBrief['trend']
  }[]) {
    trendByContact.set(e.contact_id, e.trend)
  }

  const openByContact = new Map<string, number>()
  for (const c of (commitmentsRes.data ?? []) as {
    contact_id: string | null
    status: string
  }[]) {
    if (!c.contact_id) continue
    openByContact.set(c.contact_id, (openByContact.get(c.contact_id) ?? 0) + 1)
  }

  const meetings: MeetingCard[] = byEvent.map(({ ev, emails }) => {
    const seen = new Set<string>()
    const attendees: AttendeeBrief[] = []
    for (const email of emails) {
      const c = emailToContact.get(email)
      if (!c) continue
      if (seen.has(c.id)) continue
      seen.add(c.id)
      attendees.push({
        contact_id: c.id,
        name: contactName(c),
        tier: c.tier,
        last_interaction_at: c.last_interaction_at,
        open_commitments: openByContact.get(c.id) ?? 0,
        trend: trendByContact.get(c.id) ?? null,
      })
    }
    return {
      id: ev.id,
      title: ev.title,
      start_at: ev.start_at,
      end_at: ev.end_at,
      conference_url: ev.conference_url,
      location: ev.location,
      attendees,
    }
  })

  return { meetings, calendarConnected: true }
}
