// ---------------------------------------------------------------------------
// computeRelationshipEdges — observation layer for AIEA Layer 1.
//
// For every contact the executive has interacted with in the last 90 days,
// distill a directed weighted edge: strength, trend, reciprocity, response
// time, and who initiates. Reads messages + calendar_events + interactions;
// upserts into relationship_edges.
//
// Strength is a composite score:
//   0.30 frequency  · 0.25 reciprocity · 0.20 consistency
//   0.15 recency    · 0.10 visibility (calendar co-attendance)
//
// Trend rule (from the spec):
//   no interaction in 60d              → dormant
//   interactions_30d > 1.5 · 90d_rate  → warming
//   interactions_30d < 0.5 · 90d_rate  → cooling
//   otherwise                          → stable
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'

const LOOKBACK_DAYS = 90
const SHORT_WINDOW_DAYS = 30
const DORMANT_DAYS = 60
const WARMING_RATIO = 1.5
const COOLING_RATIO = 0.5
const FREQUENCY_SATURATION = 30 // interactions/90d that maps to score 1.0
const NEW_THREAD_GAP_HOURS = 24

const W_FREQUENCY = 0.3
const W_RECIPROCITY = 0.25
const W_CONSISTENCY = 0.2
const W_RECENCY = 0.15
const W_VISIBILITY = 0.1

export type RelationshipEdgePayload = {
  contact_id: string
  strength: number
  trend: 'warming' | 'stable' | 'cooling' | 'dormant'
  last_interaction_at: string | null
  interaction_count_30d: number
  interaction_count_90d: number
  reciprocity_score: number | null
  avg_response_time_hours: number | null
  initiated_by_me_pct: number | null
}

type MessageRow = {
  id: string
  contact_id: string | null
  thread_id: string | null
  direction: 'inbound' | 'outbound' | null
  sent_at: string | null
}

type CalendarRow = {
  id: string
  contact_id: string | null
  start_at: string | null
  attendees: unknown
}

type InteractionRow = {
  id: string
  contact_id: string | null
  direction: 'inbound' | 'outbound' | null
  occurred_at: string | null
}

type Aggregate = {
  inbound: { ts: number; thread: string | null }[]
  outbound: { ts: number; thread: string | null }[]
  meetingCount: number
  weeksWithActivity: Set<number>
}

export async function computeRelationshipEdges(
  service: SupabaseClient,
  userId: string,
): Promise<RelationshipEdgePayload[]> {
  const now = Date.now()
  const since = new Date(now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const shortSince = now - SHORT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const dormantSince = now - DORMANT_DAYS * 24 * 60 * 60 * 1000

  const [messagesRes, calendarRes, interactionsRes] = await Promise.all([
    service
      .from('messages')
      .select('id, contact_id, thread_id, direction, sent_at')
      .eq('user_id', userId)
      .gte('sent_at', since)
      .not('contact_id', 'is', null)
      .order('sent_at', { ascending: true })
      .limit(20000),
    service
      .from('calendar_events')
      .select('id, contact_id, start_at, attendees')
      .eq('user_id', userId)
      .gte('start_at', since)
      .limit(5000),
    service
      .from('interactions')
      .select('id, contact_id, direction, occurred_at')
      .eq('user_id', userId)
      .gte('occurred_at', since)
      .not('contact_id', 'is', null)
      .order('occurred_at', { ascending: true })
      .limit(20000),
  ])

  const messages = (messagesRes.data ?? []) as MessageRow[]
  const events = (calendarRes.data ?? []) as CalendarRow[]
  const interactions = (interactionsRes.data ?? []) as InteractionRow[]

  const byContact = new Map<string, Aggregate>()
  function getAgg(cid: string): Aggregate {
    let a = byContact.get(cid)
    if (!a) {
      a = {
        inbound: [],
        outbound: [],
        meetingCount: 0,
        weeksWithActivity: new Set<number>(),
      }
      byContact.set(cid, a)
    }
    return a
  }

  function weekIndex(ms: number): number {
    return Math.floor(ms / (7 * 24 * 60 * 60 * 1000))
  }

  for (const m of messages) {
    if (!m.contact_id || !m.sent_at) continue
    const ts = new Date(m.sent_at).getTime()
    const agg = getAgg(m.contact_id)
    if (m.direction === 'inbound')
      agg.inbound.push({ ts, thread: m.thread_id ?? null })
    else if (m.direction === 'outbound')
      agg.outbound.push({ ts, thread: m.thread_id ?? null })
    agg.weeksWithActivity.add(weekIndex(ts))
  }

  for (const i of interactions) {
    if (!i.contact_id || !i.occurred_at) continue
    const ts = new Date(i.occurred_at).getTime()
    const agg = getAgg(i.contact_id)
    if (i.direction === 'inbound')
      agg.inbound.push({ ts, thread: null })
    else if (i.direction === 'outbound')
      agg.outbound.push({ ts, thread: null })
    agg.weeksWithActivity.add(weekIndex(ts))
  }

  for (const e of events) {
    if (!e.contact_id || !e.start_at) continue
    const agg = getAgg(e.contact_id)
    agg.meetingCount += 1
    agg.weeksWithActivity.add(weekIndex(new Date(e.start_at).getTime()))
  }

  const totalWeeks = LOOKBACK_DAYS / 7
  const totalMeetings = events.length

  const out: RelationshipEdgePayload[] = []

  for (const [cid, agg] of byContact) {
    const all = [...agg.inbound, ...agg.outbound].sort((a, b) => a.ts - b.ts)
    if (all.length === 0 && agg.meetingCount === 0) continue

    const count90 = all.length + agg.meetingCount
    const count30 =
      all.filter((x) => x.ts >= shortSince).length +
      events.filter(
        (e) =>
          e.contact_id === cid &&
          e.start_at != null &&
          new Date(e.start_at).getTime() >= shortSince,
      ).length

    const lastTs = all.length > 0 ? all[all.length - 1]!.ts : 0
    const lastMeetingTs = events
      .filter((e) => e.contact_id === cid && e.start_at != null)
      .reduce(
        (acc, e) => Math.max(acc, new Date(e.start_at!).getTime()),
        0,
      )
    const lastActivityTs = Math.max(lastTs, lastMeetingTs)
    const lastInteractionAt =
      lastActivityTs > 0 ? new Date(lastActivityTs).toISOString() : null

    // Frequency (30% weight)
    const frequency = Math.min(1, count90 / FREQUENCY_SATURATION)

    // Reciprocity = outbound / (inbound + outbound) — 0.5 is balanced.
    // We score it as 1 - distance from 0.5, scaled.
    const inb = agg.inbound.length
    const outb = agg.outbound.length
    let reciprocityScore: number | null = null
    let reciprocityComponent = 0.5
    if (inb + outb >= 2) {
      const ratio = outb / (inb + outb)
      reciprocityScore = round(ratio, 3)
      reciprocityComponent = 1 - Math.min(1, Math.abs(ratio - 0.5) * 2)
    }

    // Consistency: weeks with any activity / total weeks
    const consistency = Math.min(1, agg.weeksWithActivity.size / totalWeeks)

    // Recency: 1 if today, decays linearly to 0 over 90 days
    const daysSince =
      lastActivityTs > 0
        ? (now - lastActivityTs) / (24 * 60 * 60 * 1000)
        : LOOKBACK_DAYS
    const recency = Math.max(0, 1 - daysSince / LOOKBACK_DAYS)

    // Visibility: meeting co-attendance share, capped
    const visibility =
      totalMeetings > 0
        ? Math.min(1, agg.meetingCount / Math.max(1, totalMeetings * 0.25))
        : 0

    const strength = round(
      W_FREQUENCY * frequency +
        W_RECIPROCITY * reciprocityComponent +
        W_CONSISTENCY * consistency +
        W_RECENCY * recency +
        W_VISIBILITY * visibility,
      3,
    )

    // Trend
    let trend: 'warming' | 'stable' | 'cooling' | 'dormant'
    if (lastActivityTs > 0 && lastActivityTs < dormantSince) {
      trend = 'dormant'
    } else {
      const expected30 = (count90 / LOOKBACK_DAYS) * SHORT_WINDOW_DAYS
      if (expected30 >= 0.5 && count30 > expected30 * WARMING_RATIO)
        trend = 'warming'
      else if (expected30 >= 0.5 && count30 < expected30 * COOLING_RATIO)
        trend = 'cooling'
      else trend = 'stable'
    }

    // Avg response time (hours): when an inbound is followed by an outbound
    // within 14 days in the same thread (or any outbound if no thread).
    const respHours: number[] = []
    const sortedIn = [...agg.inbound].sort((a, b) => a.ts - b.ts)
    const sortedOut = [...agg.outbound].sort((a, b) => a.ts - b.ts)
    let oi = 0
    for (const ib of sortedIn) {
      while (oi < sortedOut.length && sortedOut[oi]!.ts <= ib.ts) oi++
      if (oi >= sortedOut.length) break
      // Prefer same-thread reply if available
      const sameThread = sortedOut
        .slice(oi)
        .find(
          (o) => ib.thread != null && o.thread === ib.thread,
        )
      const next = sameThread ?? sortedOut[oi]
      const hours = (next!.ts - ib.ts) / (60 * 60 * 1000)
      if (hours >= 0 && hours <= 14 * 24) respHours.push(hours)
    }
    const avgResponseHours =
      respHours.length > 0 ? round(mean(respHours), 2) : null

    // Initiated-by-me-pct: count "threads" the user started. A thread is
    // started when the user sends a message with no inbound from this
    // contact in the prior 24h. We use messages only (interactions don't
    // have thread context) and fall back to a 24h gap heuristic.
    let initiatedByMe = 0
    let totalThreads = 0
    const allEvents = [...agg.inbound, ...agg.outbound].sort(
      (a, b) => a.ts - b.ts,
    )
    let lastEventTs = -Infinity
    for (const ev of allEvents) {
      const isStart =
        ev.ts - lastEventTs >= NEW_THREAD_GAP_HOURS * 60 * 60 * 1000
      if (isStart) {
        totalThreads += 1
        if (agg.outbound.some((o) => o.ts === ev.ts && o.thread === ev.thread))
          initiatedByMe += 1
      }
      lastEventTs = ev.ts
    }
    const initiatedByMePct =
      totalThreads > 0 ? round(initiatedByMe / totalThreads, 3) : null

    out.push({
      contact_id: cid,
      strength,
      trend,
      last_interaction_at: lastInteractionAt,
      interaction_count_30d: count30,
      interaction_count_90d: count90,
      reciprocity_score: reciprocityScore,
      avg_response_time_hours: avgResponseHours,
      initiated_by_me_pct: initiatedByMePct,
    })
  }

  if (out.length === 0) return out

  const nowIso = new Date().toISOString()
  const rows = out.map((e) => ({
    user_id: userId,
    contact_id: e.contact_id,
    strength: e.strength,
    trend: e.trend,
    last_interaction_at: e.last_interaction_at,
    interaction_count_30d: e.interaction_count_30d,
    interaction_count_90d: e.interaction_count_90d,
    reciprocity_score: e.reciprocity_score,
    avg_response_time_hours: e.avg_response_time_hours,
    initiated_by_me_pct: e.initiated_by_me_pct,
    last_computed_at: nowIso,
  }))

  // Upsert in chunks to keep the request size reasonable.
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    await service
      .from('relationship_edges')
      .upsert(slice, { onConflict: 'user_id,contact_id' })
  }

  return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits)
  return Math.round(n * f) / f
}
