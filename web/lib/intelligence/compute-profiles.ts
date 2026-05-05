// ---------------------------------------------------------------------------
// computeUserProfile — observation layer for AIEA Layer 1.
//
// Looks at the last 90 days of the executive's actual behavior (messages,
// calendar_events, interactions, commitments) and distills a small set of
// behavioral signals: when they're active, how fast they reply, who they
// reply fast/slow to, how many meetings they tolerate per day, the top
// 25 contacts they engage with, and their email communication style.
//
// One row per user. Upserts via the service-role client (caller's
// responsibility to scope by user_id; service role bypasses RLS).
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'

const LOOKBACK_DAYS = 90
const MIN_PAIRS_FOR_RESPONSE_SIGNAL = 3
const FAST_REPLY_MAX_MINUTES = 60
const SLOW_REPLY_MIN_MINUTES = 24 * 60
const TOP_CONTACTS_LIMIT = 25
const ACTIVITY_PERCENTILE_LOW = 0.1
const ACTIVITY_PERCENTILE_HIGH = 0.9

export type TopContact = {
  contact_id: string
  interaction_count: number
  score: number
}

export type CommunicationStyle = {
  avg_outbound_length_chars: number | null
  median_outbound_length_chars: number | null
  short_reply_pct: number | null
  exclamation_pct: number | null
  question_pct: number | null
  greetings_per_message: number | null
  signoff_per_message: number | null
  formality_score: number | null
  outbound_sample_size: number
}

export type UserProfilePayload = {
  user_id: string
  avg_response_time_minutes: number | null
  fast_reply_contacts: string[]
  slow_reply_contacts: string[]
  active_hours_start: number | null
  active_hours_end: number | null
  meeting_tolerance_daily: number | null
  top_contacts: TopContact[]
  communication_style: CommunicationStyle
  last_computed_at: string
}

type MessageRow = {
  id: string
  contact_id: string | null
  thread_id: string | null
  direction: 'inbound' | 'outbound' | null
  sent_at: string | null
  body: string | null
  subject: string | null
}

type CalendarRow = {
  id: string
  start_at: string | null
  end_at: string | null
  attendees: unknown
}

type InteractionRow = {
  id: string
  contact_id: string | null
  direction: 'inbound' | 'outbound' | null
  body: string | null
  occurred_at: string | null
}

export async function computeUserProfile(
  service: SupabaseClient,
  userId: string,
): Promise<UserProfilePayload> {
  const since = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const [messagesRes, calendarRes, interactionsRes] = await Promise.all([
    service
      .from('messages')
      .select('id, contact_id, thread_id, direction, sent_at, body, subject')
      .eq('user_id', userId)
      .gte('sent_at', since)
      .order('sent_at', { ascending: true })
      .limit(10000),
    service
      .from('calendar_events')
      .select('id, start_at, end_at, attendees')
      .eq('user_id', userId)
      .gte('start_at', since)
      .limit(5000),
    service
      .from('interactions')
      .select('id, contact_id, direction, body, occurred_at')
      .eq('user_id', userId)
      .gte('occurred_at', since)
      .limit(10000),
  ])

  const messages = ((messagesRes.data ?? []) as MessageRow[]).filter(
    (m) => m.sent_at != null,
  )
  const events = (calendarRes.data ?? []) as CalendarRow[]
  const interactions = ((interactionsRes.data ?? []) as InteractionRow[]).filter(
    (i) => i.occurred_at != null,
  )

  // ---------------------------------------------------------------------
  // Response time per contact (inbound -> next outbound within thread)
  // ---------------------------------------------------------------------
  const replyMinutesByContact = new Map<string, number[]>()
  const messagesByThread = new Map<string, MessageRow[]>()
  for (const m of messages) {
    const tid = m.thread_id ?? `__no_thread:${m.id}`
    const arr = messagesByThread.get(tid) ?? []
    arr.push(m)
    messagesByThread.set(tid, arr)
  }
  for (const arr of messagesByThread.values()) {
    arr.sort(
      (a, b) =>
        new Date(a.sent_at!).getTime() - new Date(b.sent_at!).getTime(),
    )
    let pendingInbound: MessageRow | null = null
    for (const m of arr) {
      if (m.direction === 'inbound') {
        if (!pendingInbound) pendingInbound = m
      } else if (m.direction === 'outbound' && pendingInbound) {
        const contactId = pendingInbound.contact_id ?? m.contact_id
        if (contactId) {
          const minutes =
            (new Date(m.sent_at!).getTime() -
              new Date(pendingInbound.sent_at!).getTime()) /
            60000
          if (minutes >= 0 && minutes <= 14 * 24 * 60) {
            const list = replyMinutesByContact.get(contactId) ?? []
            list.push(minutes)
            replyMinutesByContact.set(contactId, list)
          }
        }
        pendingInbound = null
      }
    }
  }

  const allReplyMinutes: number[] = []
  for (const list of replyMinutesByContact.values())
    for (const v of list) allReplyMinutes.push(v)
  const avgResponseMinutes =
    allReplyMinutes.length > 0
      ? round(mean(allReplyMinutes), 1)
      : null

  const fastReplyContacts: string[] = []
  const slowReplyContacts: string[] = []
  for (const [cid, list] of replyMinutesByContact) {
    if (list.length < MIN_PAIRS_FOR_RESPONSE_SIGNAL) continue
    const med = median(list)
    if (med <= FAST_REPLY_MAX_MINUTES) fastReplyContacts.push(cid)
    else if (med >= SLOW_REPLY_MIN_MINUTES) slowReplyContacts.push(cid)
  }

  // ---------------------------------------------------------------------
  // Active hours from outbound message timestamps (local hour-of-day)
  // ---------------------------------------------------------------------
  const outboundHours: number[] = []
  for (const m of messages) {
    if (m.direction !== 'outbound' || !m.sent_at) continue
    const h = new Date(m.sent_at).getHours()
    outboundHours.push(h)
  }
  for (const i of interactions) {
    if (i.direction !== 'outbound' || !i.occurred_at) continue
    outboundHours.push(new Date(i.occurred_at).getHours())
  }
  let activeStart: number | null = null
  let activeEnd: number | null = null
  if (outboundHours.length >= 10) {
    const sorted = [...outboundHours].sort((a, b) => a - b)
    activeStart = Math.floor(percentile(sorted, ACTIVITY_PERCENTILE_LOW))
    activeEnd = Math.ceil(percentile(sorted, ACTIVITY_PERCENTILE_HIGH))
    if (activeEnd > 23) activeEnd = 23
    if (activeStart < 0) activeStart = 0
  }

  // ---------------------------------------------------------------------
  // Meeting tolerance — average meetings/day on days with any meeting
  // ---------------------------------------------------------------------
  const meetingsByDay = new Map<string, number>()
  for (const e of events) {
    if (!e.start_at) continue
    const attendeeCount = countAttendees(e.attendees)
    // Pure focus blocks (no other attendees) don't count as "meetings".
    if (attendeeCount < 1) continue
    const day = e.start_at.slice(0, 10)
    meetingsByDay.set(day, (meetingsByDay.get(day) ?? 0) + 1)
  }
  const meetingTolerance =
    meetingsByDay.size > 0
      ? round(
          [...meetingsByDay.values()].reduce((a, b) => a + b, 0) /
            meetingsByDay.size,
          2,
        )
      : null

  // ---------------------------------------------------------------------
  // Top contacts by interaction frequency (messages + interactions)
  // ---------------------------------------------------------------------
  const interactionCount = new Map<string, number>()
  for (const m of messages) {
    if (!m.contact_id) continue
    interactionCount.set(
      m.contact_id,
      (interactionCount.get(m.contact_id) ?? 0) + 1,
    )
  }
  for (const i of interactions) {
    if (!i.contact_id) continue
    interactionCount.set(
      i.contact_id,
      (interactionCount.get(i.contact_id) ?? 0) + 1,
    )
  }
  const sortedCounts = [...interactionCount.entries()].sort(
    (a, b) => b[1] - a[1],
  )
  const maxCount = sortedCounts[0]?.[1] ?? 0
  const topContacts: TopContact[] = sortedCounts
    .slice(0, TOP_CONTACTS_LIMIT)
    .map(([contact_id, n]) => ({
      contact_id,
      interaction_count: n,
      score: maxCount > 0 ? round(n / maxCount, 3) : 0,
    }))

  // ---------------------------------------------------------------------
  // Communication style — outbound message text patterns
  // ---------------------------------------------------------------------
  const outboundBodies = messages
    .filter((m) => m.direction === 'outbound' && typeof m.body === 'string')
    .map((m) => stripQuotedReply(m.body!))
    .filter((b) => b.length > 0)

  let style: CommunicationStyle
  if (outboundBodies.length === 0) {
    style = {
      avg_outbound_length_chars: null,
      median_outbound_length_chars: null,
      short_reply_pct: null,
      exclamation_pct: null,
      question_pct: null,
      greetings_per_message: null,
      signoff_per_message: null,
      formality_score: null,
      outbound_sample_size: 0,
    }
  } else {
    const lengths = outboundBodies.map((b) => b.length)
    const shortCount = lengths.filter((l) => l < 200).length
    const exclam = outboundBodies.filter((b) => b.includes('!')).length
    const ques = outboundBodies.filter((b) => b.includes('?')).length
    const greet = outboundBodies.filter((b) =>
      /^\s*(hi|hey|hello|good (morning|afternoon|evening))\b/i.test(b),
    ).length
    const sign = outboundBodies.filter((b) =>
      /(thanks|thank you|cheers|best|regards|sincerely|talk soon|—\s*[a-z]+)\s*$/i.test(
        b.trim(),
      ),
    ).length

    // Crude formality heuristic: longer + more signoffs + fewer exclamations
    // pushes toward formal; the inverse pushes toward casual. Range 0..1
    // where 1 = formal, 0 = casual.
    const avgLen = mean(lengths)
    const lengthSignal = Math.min(1, avgLen / 600)
    const signoffSignal = sign / outboundBodies.length
    const exclamSignal = 1 - exclam / outboundBodies.length
    const formality = round(
      0.4 * lengthSignal + 0.3 * signoffSignal + 0.3 * exclamSignal,
      3,
    )

    style = {
      avg_outbound_length_chars: round(avgLen, 1),
      median_outbound_length_chars: round(median(lengths), 1),
      short_reply_pct: round(shortCount / outboundBodies.length, 3),
      exclamation_pct: round(exclam / outboundBodies.length, 3),
      question_pct: round(ques / outboundBodies.length, 3),
      greetings_per_message: round(greet / outboundBodies.length, 3),
      signoff_per_message: round(sign / outboundBodies.length, 3),
      formality_score: formality,
      outbound_sample_size: outboundBodies.length,
    }
  }

  const payload: UserProfilePayload = {
    user_id: userId,
    avg_response_time_minutes: avgResponseMinutes,
    fast_reply_contacts: fastReplyContacts,
    slow_reply_contacts: slowReplyContacts,
    active_hours_start: activeStart,
    active_hours_end: activeEnd,
    meeting_tolerance_daily: meetingTolerance,
    top_contacts: topContacts,
    communication_style: style,
    last_computed_at: new Date().toISOString(),
  }

  // Upsert (service role bypasses RLS; caller is responsible for scoping
  // by user_id).
  await service.from('user_profiles').upsert(
    {
      user_id: userId,
      avg_response_time_minutes: payload.avg_response_time_minutes,
      fast_reply_contacts: payload.fast_reply_contacts,
      slow_reply_contacts: payload.slow_reply_contacts,
      active_hours_start: payload.active_hours_start,
      active_hours_end: payload.active_hours_end,
      meeting_tolerance_daily: payload.meeting_tolerance_daily,
      top_contacts: payload.top_contacts,
      communication_style: payload.communication_style,
      last_computed_at: payload.last_computed_at,
    },
    { onConflict: 'user_id' },
  )

  return payload
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countAttendees(raw: unknown): number {
  if (!Array.isArray(raw)) return 0
  // Attendees jsonb is a list; each entry may be a string email or an object.
  // We don't try to exclude the user themselves — for "did they take a
  // meeting today?" the user's own row doesn't change the answer.
  return raw.length
}

function stripQuotedReply(body: string): string {
  // Cut the first quote marker; gmail bodies typically include the prior
  // message inline. Heuristic but cheap.
  const cuts = [
    /\nOn .{0,80}wrote:\s*\n/,
    /\n>+\s/,
    /\n-{2,}\s*Original Message/i,
    /\nFrom: .{0,200}\nSent: /i,
  ]
  let trimmed = body
  for (const re of cuts) {
    const m = trimmed.match(re)
    if (m && typeof m.index === 'number') trimmed = trimmed.slice(0, m.index)
  }
  return trimmed.trim()
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  )
  return sorted[idx]!
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits)
  return Math.round(n * f) / f
}
