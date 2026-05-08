// Loader for the /briefings page and /api/briefings route.
//
// Builds a "pre-meeting briefing" payload for every upcoming calendar
// event in a configurable window. Extends loadUpcomingMeetings (which
// only returns matched-contact attendees in a 24h window) by:
//   - widening the window to 48h by default
//   - keeping unmatched attendees so the UI can offer "Add to contacts"
//   - pulling the latest 3 messages per matched contact for context
//   - exposing pipeline_stage / pipeline_notes
//   - composing a compact "talking points" list from notes + recent activity
//
// Matched attendees are joined to contacts via lowercased email — same
// rule as upcoming-meetings.ts so the two stay consistent.
//
// Returns null calendarConnected when the user has zero calendar_events
// rows ever, so UIs can show a connect-prompt instead of an empty list.
//
// All Supabase calls are RLS-scoped by user_id; we still pass userId
// explicitly because some callers run on the service role.
//
// Server-only — uses the @supabase/supabase-js types but expects a
// session-scoped client (createClient from lib/supabase/server).

import type { SupabaseClient } from '@supabase/supabase-js'
import { contactName } from '../format'
import type { PipelineStage, Tier } from '../types'

export type MessageDigestItem = {
  id: string
  channel: 'email' | 'imessage' | 'sms'
  direction: 'inbound' | 'outbound'
  subject: string | null
  snippet: string | null
  sent_at: string
}

export type CommitmentDigestItem = {
  id: string
  description: string
  owner: 'me' | 'them'
  due_at: string | null
}

export type MatchedAttendee = {
  kind: 'matched'
  contact_id: string
  email: string
  name: string
  tier: Tier | null
  pipeline_stage: PipelineStage | null
  pipeline_notes: string | null
  last_interaction_at: string | null
  half_life_days: number | null
  // Days since last contact, or null if never. Convenience for UI.
  days_since_contact: number | null
  // Bucketed health label derived from half-life vs. days_since_contact.
  health: 'strong' | 'steady' | 'cooling' | 'cold' | 'unknown'
  trend: 'warming' | 'stable' | 'cooling' | 'dormant' | null
  open_commitments: CommitmentDigestItem[]
  recent_messages: MessageDigestItem[]
}

export type UnmatchedAttendee = {
  kind: 'unmatched'
  email: string
  name: string | null
}

export type Attendee = MatchedAttendee | UnmatchedAttendee

export type Briefing = {
  event_id: string
  title: string | null
  start_at: string
  end_at: string | null
  location: string | null
  conference_url: string | null
  html_link: string | null
  description: string | null
  attendees: Attendee[]
  // Composed talking points / things to remember. Deterministic — built
  // from open commitments, pipeline notes, and the most recent messages.
  talking_points: string[]
}

export type BriefingsResult = {
  briefings: Briefing[]
  calendarConnected: boolean
}

type RawAttendee = {
  email?: string | null
  name?: string | null
  response?: string | null
  organizer?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_HOURS = 48
const MAX_MESSAGES_PER_CONTACT = 3
const MAX_TALKING_POINTS = 5

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / DAY_MS)
}

function bucketHealth(
  daysSinceContact: number | null,
  halfLife: number | null,
): MatchedAttendee['health'] {
  if (daysSinceContact == null) return 'unknown'
  if (halfLife != null && halfLife > 0) {
    const ratio = daysSinceContact / halfLife
    if (ratio < 0.5) return 'strong'
    if (ratio < 1.0) return 'steady'
    if (ratio < 2.0) return 'cooling'
    return 'cold'
  }
  if (daysSinceContact < 14) return 'strong'
  if (daysSinceContact < 30) return 'steady'
  if (daysSinceContact < 60) return 'cooling'
  return 'cold'
}

// Compose the talking points / things to remember for a single meeting.
// Ranked: open commitments > pipeline notes > what they said recently.
// Capped at MAX_TALKING_POINTS so the UI doesn't sprawl.
function composeTalkingPoints(attendees: MatchedAttendee[]): string[] {
  const points: string[] = []

  for (const a of attendees) {
    for (const c of a.open_commitments) {
      const tag = c.owner === 'me' ? 'You owe' : 'They owe'
      const due = c.due_at ? ` (due ${c.due_at.slice(0, 10)})` : ''
      points.push(`${tag} ${a.name}: ${c.description}${due}`)
    }
  }

  for (const a of attendees) {
    if (a.pipeline_notes && a.pipeline_notes.trim().length > 0) {
      const trimmed = a.pipeline_notes.trim().slice(0, 200)
      points.push(`${a.name} — ${trimmed}`)
    }
  }

  for (const a of attendees) {
    const inbound = a.recent_messages.find((m) => m.direction === 'inbound')
    if (inbound && (inbound.subject || inbound.snippet)) {
      const text = (inbound.subject ?? inbound.snippet ?? '').trim().slice(0, 160)
      if (text) points.push(`${a.name} last said: ${text}`)
    }
  }

  for (const a of attendees) {
    if (a.health === 'cooling' || a.health === 'cold') {
      const days = a.days_since_contact
      points.push(
        `${a.name} is ${a.health}${days != null ? ` — ${days}d since last contact` : ''}.`,
      )
    }
  }

  return points.slice(0, MAX_TALKING_POINTS)
}

export async function loadBriefings(
  supabase: SupabaseClient,
  userId: string,
  options?: { windowHours?: number; now?: Date; limit?: number },
): Promise<BriefingsResult> {
  const now = options?.now ?? new Date()
  const windowHours = options?.windowHours ?? DEFAULT_WINDOW_HOURS
  const limit = options?.limit ?? 25
  const horizon = new Date(now.getTime() + windowHours * 60 * 60 * 1000)

  const probe = await supabase
    .from('calendar_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .limit(1)

  if (probe.error) {
    console.error('[briefings] probe failed', probe.error)
    return { briefings: [], calendarConnected: false }
  }
  if ((probe.count ?? 0) === 0) {
    return { briefings: [], calendarConnected: false }
  }

  const eventsRes = await supabase
    .from('calendar_events')
    .select(
      'id, title, description, start_at, end_at, location, conference_url, html_link, attendees',
    )
    .eq('user_id', userId)
    .gte('start_at', now.toISOString())
    .lte('start_at', horizon.toISOString())
    .order('start_at', { ascending: true })
    .limit(limit)

  if (eventsRes.error) {
    console.error('[briefings] events query failed', eventsRes.error)
    return { briefings: [], calendarConnected: true }
  }

  type EventRow = {
    id: string
    title: string | null
    description: string | null
    start_at: string
    end_at: string | null
    location: string | null
    conference_url: string | null
    html_link: string | null
    attendees: unknown
  }
  const events = (eventsRes.data ?? []) as EventRow[]

  if (events.length === 0) {
    return { briefings: [], calendarConnected: true }
  }

  // Per-event raw attendee parsing. Lowercase emails for join consistency.
  const allEmails = new Set<string>()
  type RawByEvent = {
    ev: EventRow
    raw: { email: string; name: string | null }[]
  }
  const byEvent: RawByEvent[] = []
  for (const ev of events) {
    const arr = Array.isArray(ev.attendees) ? (ev.attendees as RawAttendee[]) : []
    const raw: RawByEvent['raw'] = []
    const seen = new Set<string>()
    for (const a of arr) {
      if (typeof a?.email !== 'string') continue
      const email = a.email.toLowerCase().trim()
      if (!email) continue
      if (seen.has(email)) continue
      seen.add(email)
      const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : null
      raw.push({ email, name })
      allEmails.add(email)
    }
    byEvent.push({ ev, raw })
  }

  if (allEmails.size === 0) {
    return {
      briefings: events.map((ev) => ({
        event_id: ev.id,
        title: ev.title,
        start_at: ev.start_at,
        end_at: ev.end_at,
        location: ev.location,
        conference_url: ev.conference_url,
        html_link: ev.html_link,
        description: ev.description,
        attendees: [],
        talking_points: [],
      })),
      calendarConnected: true,
    }
  }

  const emailList = Array.from(allEmails)

  const [contactsRes, edgesRes, commitmentsRes] = await Promise.all([
    supabase
      .from('contacts')
      .select(
        'id, first_name, last_name, email, tier, last_interaction_at, half_life_days, pipeline_stage, pipeline_notes',
      )
      .eq('user_id', userId)
      .in('email', emailList),
    supabase
      .from('relationship_edges')
      .select('contact_id, trend')
      .eq('user_id', userId),
    supabase
      .from('commitments')
      .select('id, contact_id, description, owner, due_at, status')
      .eq('user_id', userId)
      .eq('status', 'open'),
  ])

  if (contactsRes.error) console.error('[briefings] contacts', contactsRes.error)
  if (edgesRes.error) console.error('[briefings] edges', edgesRes.error)
  if (commitmentsRes.error) console.error('[briefings] commitments', commitmentsRes.error)

  type ContactRow = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    tier: Tier | null
    last_interaction_at: string | null
    half_life_days: number | null
    pipeline_stage: PipelineStage | null
    pipeline_notes: string | null
  }
  const contacts = (contactsRes.data ?? []) as ContactRow[]

  const emailToContact = new Map<string, ContactRow>()
  for (const c of contacts) {
    if (c.email) emailToContact.set(c.email.toLowerCase().trim(), c)
  }
  const contactIds = contacts.map((c) => c.id)

  const trendByContact = new Map<string, MatchedAttendee['trend']>()
  for (const e of (edgesRes.data ?? []) as {
    contact_id: string
    trend: MatchedAttendee['trend']
  }[]) {
    trendByContact.set(e.contact_id, e.trend)
  }

  const commitmentsByContact = new Map<string, CommitmentDigestItem[]>()
  for (const c of (commitmentsRes.data ?? []) as {
    id: string
    contact_id: string | null
    description: string
    owner: 'me' | 'them'
    due_at: string | null
    status: string
  }[]) {
    if (!c.contact_id) continue
    const existing = commitmentsByContact.get(c.contact_id) ?? []
    existing.push({
      id: c.id,
      description: c.description,
      owner: c.owner,
      due_at: c.due_at,
    })
    commitmentsByContact.set(c.contact_id, existing)
  }

  // Pull recent messages for matched contacts in one query, then group.
  const messagesByContact = new Map<string, MessageDigestItem[]>()
  if (contactIds.length > 0) {
    const messagesRes = await supabase
      .from('messages')
      .select('id, channel, direction, subject, snippet, sent_at, contact_id')
      .eq('user_id', userId)
      .in('contact_id', contactIds)
      .order('sent_at', { ascending: false })
      .limit(contactIds.length * MAX_MESSAGES_PER_CONTACT * 2)

    if (messagesRes.error) {
      console.error('[briefings] messages', messagesRes.error)
    }
    for (const m of (messagesRes.data ?? []) as {
      id: string
      channel: MessageDigestItem['channel']
      direction: MessageDigestItem['direction']
      subject: string | null
      snippet: string | null
      sent_at: string
      contact_id: string | null
    }[]) {
      if (!m.contact_id) continue
      const list = messagesByContact.get(m.contact_id) ?? []
      if (list.length >= MAX_MESSAGES_PER_CONTACT) continue
      list.push({
        id: m.id,
        channel: m.channel,
        direction: m.direction,
        subject: m.subject,
        snippet: m.snippet,
        sent_at: m.sent_at,
      })
      messagesByContact.set(m.contact_id, list)
    }
  }

  const briefings: Briefing[] = byEvent.map(({ ev, raw }) => {
    const matched: MatchedAttendee[] = []
    const unmatched: UnmatchedAttendee[] = []
    for (const a of raw) {
      const c = emailToContact.get(a.email)
      if (c) {
        const days = daysSince(c.last_interaction_at)
        matched.push({
          kind: 'matched',
          contact_id: c.id,
          email: a.email,
          name: contactName(c),
          tier: c.tier,
          pipeline_stage: c.pipeline_stage,
          pipeline_notes: c.pipeline_notes,
          last_interaction_at: c.last_interaction_at,
          half_life_days: c.half_life_days,
          days_since_contact: days,
          health: bucketHealth(days, c.half_life_days),
          trend: trendByContact.get(c.id) ?? null,
          open_commitments: commitmentsByContact.get(c.id) ?? [],
          recent_messages: messagesByContact.get(c.id) ?? [],
        })
      } else {
        unmatched.push({ kind: 'unmatched', email: a.email, name: a.name })
      }
    }
    const attendees: Attendee[] = [...matched, ...unmatched]
    return {
      event_id: ev.id,
      title: ev.title,
      start_at: ev.start_at,
      end_at: ev.end_at,
      location: ev.location,
      conference_url: ev.conference_url,
      html_link: ev.html_link,
      description: ev.description,
      attendees,
      talking_points: composeTalkingPoints(matched),
    }
  })

  return { briefings, calendarConnected: true }
}

export async function loadBriefingById(
  supabase: SupabaseClient,
  userId: string,
  eventId: string,
): Promise<Briefing | null> {
  const eventRes = await supabase
    .from('calendar_events')
    .select(
      'id, title, description, start_at, end_at, location, conference_url, html_link, attendees',
    )
    .eq('id', eventId)
    .eq('user_id', userId)
    .maybeSingle()

  if (eventRes.error) {
    console.error('[briefings] detail fetch failed', eventRes.error)
    return null
  }
  const ev = eventRes.data as {
    id: string
    title: string | null
    description: string | null
    start_at: string
    end_at: string | null
    location: string | null
    conference_url: string | null
    html_link: string | null
    attendees: unknown
  } | null
  if (!ev) return null

  // Run the bulk loader pinned to a window that brackets this event so it
  // can reuse all the matching/digest logic. Anchor at start_at minus a
  // small slack so the event is always inside the window.
  const eventStart = new Date(ev.start_at)
  if (Number.isNaN(eventStart.getTime())) return null
  const anchor = new Date(eventStart.getTime() - 60 * 60 * 1000)
  const horizonHours =
    (eventStart.getTime() - anchor.getTime()) / (60 * 60 * 1000) + 24

  const { briefings } = await loadBriefings(supabase, userId, {
    windowHours: horizonHours,
    limit: 200,
    now: anchor,
  })
  return briefings.find((b) => b.event_id === eventId) ?? null
}
