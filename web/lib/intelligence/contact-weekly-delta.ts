// ---------------------------------------------------------------------------
// loadContactWeeklyDelta — "what changed with this contact in the last 7 days."
//
// Sibling to the momentum sparkline: where momentum shows the trend line,
// this card itemises the *events* that drove (or could drive) the trend.
// Pulls 7d of snapshots, commitments, messages, life-events into a single
// structured payload, deduped and ready to render.
//
// Pure server-side read — no API route, no LLM, no migration.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PersonalDetails } from '../types'

const WINDOW_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export type WeeklyDeltaEntry =
  | {
      kind: 'score'
      // Signed delta in 0-1 scale. Positive = warmed.
      delta: number
      current: number | null
      prior: number | null
      // Which component moved most, if known.
      label: 'composite' | 'sentiment'
    }
  | {
      kind: 'commitment_completed'
      description: string
      owner: 'me' | 'them' | null
      completed_at: string
    }
  | {
      kind: 'commitment_created'
      description: string
      owner: 'me' | 'them' | null
      created_at: string
    }
  | {
      kind: 'message_received'
      direction: 'inbound' | 'outbound'
      subject: string | null
      sent_at: string
      count: number
    }
  | {
      kind: 'life_event'
      event: string
      date: string
    }

export type ContactWeeklyDelta = {
  entries: WeeklyDeltaEntry[]
  // Used for the section header copy. NULL when the contact has no
  // history yet in any source.
  has_signal: boolean
}

type CommitmentRow = {
  id: string
  description: string
  owner: 'me' | 'them' | null
  status: string
  created_at: string
  completed_at: string | null
}

type MessageRow = {
  id: string
  direction: 'inbound' | 'outbound' | null
  subject: string | null
  sent_at: string
}

type SnapshotRow = {
  composite: number | string | null
  sentiment: number | string | null
  computed_at: string
}

export async function loadContactWeeklyDelta(
  service: SupabaseClient,
  userId: string,
  contactId: string,
  opts?: { now?: Date; personalDetails?: PersonalDetails | null },
): Promise<ContactWeeklyDelta> {
  const now = opts?.now ?? new Date()
  const windowStartIso = new Date(
    now.getTime() - WINDOW_DAYS * DAY_MS,
  ).toISOString()

  const [snapshotsRes, commitmentsRes, messagesRes] = await Promise.all([
    service
      .from('relationship_score_snapshots')
      .select('composite, sentiment, computed_at')
      .eq('user_id', userId)
      .eq('contact_id', contactId)
      .gte('computed_at', windowStartIso)
      .order('computed_at', { ascending: true })
      .limit(50),
    service
      .from('commitments')
      .select('id, description, owner, status, created_at, completed_at')
      .eq('user_id', userId)
      .eq('contact_id', contactId)
      .or(
        [
          `created_at.gte.${windowStartIso}`,
          `completed_at.gte.${windowStartIso}`,
        ].join(','),
      )
      .limit(50),
    service
      .from('messages')
      .select('id, direction, subject, sent_at')
      .eq('user_id', userId)
      .eq('contact_id', contactId)
      .gte('sent_at', windowStartIso)
      .order('sent_at', { ascending: false })
      .limit(50),
  ])

  const entries: WeeklyDeltaEntry[] = []

  // ---- score delta ----
  const snapshots = (snapshotsRes.data ?? []) as SnapshotRow[]
  if (snapshots.length >= 2) {
    const first = snapshots[0]!
    const last = snapshots[snapshots.length - 1]!
    const priorComposite = numericOrNull(first.composite)
    const currentComposite = numericOrNull(last.composite)
    if (priorComposite != null && currentComposite != null) {
      const delta = currentComposite - priorComposite
      // Only surface scoring movement if magnitude is meaningful — otherwise
      // the entry list fills with noise on stable relationships.
      if (Math.abs(delta) >= 0.05) {
        entries.push({
          kind: 'score',
          label: 'composite',
          delta,
          current: currentComposite,
          prior: priorComposite,
        })
      }
    }
  }

  // ---- commitments ----
  const commitments = (commitmentsRes.data ?? []) as CommitmentRow[]
  const windowStartTs = new Date(windowStartIso).getTime()
  for (const c of commitments) {
    if (c.completed_at) {
      const ts = new Date(c.completed_at).getTime()
      if (Number.isFinite(ts) && ts >= windowStartTs) {
        entries.push({
          kind: 'commitment_completed',
          description: c.description,
          owner: c.owner,
          completed_at: c.completed_at,
        })
        continue
      }
    }
    const createdTs = new Date(c.created_at).getTime()
    if (Number.isFinite(createdTs) && createdTs >= windowStartTs) {
      entries.push({
        kind: 'commitment_created',
        description: c.description,
        owner: c.owner,
        created_at: c.created_at,
      })
    }
  }

  // ---- messages (rolled up by direction) ----
  const messages = (messagesRes.data ?? []) as MessageRow[]
  const inboundCount = messages.filter((m) => m.direction === 'inbound').length
  const outboundCount = messages.filter((m) => m.direction === 'outbound').length
  const latestInbound = messages.find((m) => m.direction === 'inbound')
  const latestOutbound = messages.find((m) => m.direction === 'outbound')
  if (inboundCount > 0 && latestInbound) {
    entries.push({
      kind: 'message_received',
      direction: 'inbound',
      subject: latestInbound.subject,
      sent_at: latestInbound.sent_at,
      count: inboundCount,
    })
  }
  if (outboundCount > 0 && latestOutbound) {
    entries.push({
      kind: 'message_received',
      direction: 'outbound',
      subject: latestOutbound.subject,
      sent_at: latestOutbound.sent_at,
      count: outboundCount,
    })
  }

  // ---- life events (from personal_details passed in by caller) ----
  const personalDetails = opts?.personalDetails ?? null
  if (personalDetails?.life_events) {
    for (const le of personalDetails.life_events) {
      if (!le?.date || !le?.event) continue
      const t = new Date(le.date).getTime()
      if (!Number.isFinite(t)) continue
      if (t >= windowStartTs && t <= now.getTime()) {
        entries.push({
          kind: 'life_event',
          event: le.event,
          date: le.date,
        })
      }
    }
  }

  // Sort: most recent / impactful first. Score delta first (anchors the
  // narrative), then events newest-first.
  entries.sort((a, b) => {
    if (a.kind === 'score') return -1
    if (b.kind === 'score') return 1
    return entryTimestamp(b) - entryTimestamp(a)
  })

  return {
    entries,
    has_signal: entries.length > 0,
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function entryTimestamp(e: WeeklyDeltaEntry): number {
  switch (e.kind) {
    case 'commitment_completed':
      return new Date(e.completed_at).getTime()
    case 'commitment_created':
      return new Date(e.created_at).getTime()
    case 'message_received':
      return new Date(e.sent_at).getTime()
    case 'life_event':
      return new Date(e.date).getTime()
    case 'score':
      return Number.POSITIVE_INFINITY
    default:
      return 0
  }
}

function numericOrNull(n: number | string | null | undefined): number | null {
  if (n == null) return null
  const v = typeof n === 'string' ? Number(n) : n
  if (!Number.isFinite(v)) return null
  return v
}
