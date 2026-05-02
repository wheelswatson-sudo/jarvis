// ---------------------------------------------------------------------------
// Merge an ExtractedSignals payload (one email's worth) into a contact's
// personal_details JSONB so it grows a structured relationship profile over
// time. Pure function — caller persists the result.
//
// Design:
// - Append-only for trajectory data (emotional_trajectory, milestones).
// - Set-union for topics_of_interest with size cap.
// - Two-list commitment ledger (to_them vs from_them) keyed by description
//   to avoid runaway growth on retries.
// - last_meaningful_interaction overwrites only when the new interaction
//   was flagged "meaningful" by the model, so background pleasantries
//   don't bury substantive moments.
// - reciprocity_score recomputed from the merged ledgers each call.
// ---------------------------------------------------------------------------

import type {
  PersonalDetails,
  RelationshipCommitmentRecord,
  RelationshipMilestone,
  RelationshipSentimentPoint,
} from '../types'
import { RELATIONSHIP_SCHEMA_VERSION } from '../types'
import type { ExtractedSignals } from './extract-commitments'

const MAX_TOPICS = 30
const MAX_TRAJECTORY_POINTS = 60
const MAX_COMMITMENTS_PER_LIST = 50

export type MergeContext = {
  occurredAt: string
  channel: string
  // 'inbound' = message from contact to user; 'outbound' = user to contact.
  direction: 'inbound' | 'outbound'
}

export function mergeSignalsIntoDetails(
  existing: PersonalDetails | null | undefined,
  signals: ExtractedSignals,
  ctx: MergeContext,
): PersonalDetails {
  const base: PersonalDetails = { ...(existing ?? {}) }

  // ---- topics ----
  if (signals.topics.length > 0) {
    const merged = new Set(
      (base.topics_of_interest ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean),
    )
    for (const t of signals.topics) {
      const cleaned = t.toLowerCase().trim()
      if (cleaned) merged.add(cleaned)
    }
    base.topics_of_interest = Array.from(merged).slice(0, MAX_TOPICS)
  }

  // ---- communication style: keep latest non-null observation ----
  if (signals.communication_style) {
    base.communication_style = signals.communication_style
  }

  // ---- emotional trajectory ----
  if (signals.sentiment_label || Number.isFinite(signals.sentiment)) {
    const point: RelationshipSentimentPoint = {
      date: ctx.occurredAt,
      sentiment: signals.sentiment_label ?? labelFromScore(signals.sentiment),
      score: clampScore(signals.sentiment),
    }
    const existingTrajectory = base.emotional_trajectory ?? []
    const next = [...existingTrajectory, point]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(-MAX_TRAJECTORY_POINTS)
    base.emotional_trajectory = next
  }

  // ---- meaningful interaction ----
  if (signals.meaningful && signals.meaningful_summary) {
    const previous = base.last_meaningful_interaction
    if (!previous || previous.date <= ctx.occurredAt) {
      base.last_meaningful_interaction = {
        date: ctx.occurredAt,
        channel: ctx.channel,
        summary: signals.meaningful_summary,
      }
    }
    // Promote highly-confident commitments to milestones too — these are
    // the events worth resurfacing months later.
    if (signals.meaningful_summary && !milestoneExists(base.key_milestones, signals.meaningful_summary, ctx.occurredAt)) {
      const m: RelationshipMilestone = {
        date: ctx.occurredAt,
        event: signals.meaningful_summary,
      }
      base.key_milestones = [...(base.key_milestones ?? []), m]
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .slice(-MAX_TRAJECTORY_POINTS)
    }
  }

  // ---- commitment ledgers ----
  if (signals.commitments.length > 0) {
    const toThem = [...(base.active_commitments_to_them ?? [])]
    const fromThem = [...(base.active_commitments_from_them ?? [])]

    for (const c of signals.commitments) {
      // Map model-side owner + email direction → ledger.
      // owner=self  -> a commitment from the user to the contact
      // owner=contact -> from the contact to the user
      // owner=mutual -> recorded in BOTH ledgers so neither gets lost
      const record: RelationshipCommitmentRecord = {
        action: c.description,
        context: ctx.channel,
        date_promised: ctx.occurredAt,
        due: c.due_at,
        status: deriveStatus(c.due_at),
      }
      if (c.owner === 'self' || c.owner === 'mutual') {
        if (!commitmentExists(toThem, record)) toThem.push(record)
      }
      if (c.owner === 'contact' || c.owner === 'mutual') {
        if (!commitmentExists(fromThem, record)) fromThem.push(record)
      }
    }

    base.active_commitments_to_them = trimLedger(toThem)
    base.active_commitments_from_them = trimLedger(fromThem)
  }

  // ---- reciprocity score ----
  base.reciprocity_score = computeReciprocity(
    base.active_commitments_to_them,
    base.active_commitments_from_them,
  )

  base.schema_version = RELATIONSHIP_SCHEMA_VERSION
  return base
}

// Score the imbalance between commitments the user takes on and commitments
// the contact takes on. Until a completion lifecycle is wired up, we can't
// distinguish 'completed' from 'pending' — but we CAN measure who is taking
// on more accountability. Each non-overdue record counts as full investment;
// overdue records count as half (broken promises still cost the investor
// reputationally). Score in [-1, +1]: negative = user is overinvesting.
export function computeReciprocity(
  toThem: RelationshipCommitmentRecord[] | null | undefined,
  fromThem: RelationshipCommitmentRecord[] | null | undefined,
): number {
  const weight = (c: RelationshipCommitmentRecord): number =>
    c.status === 'overdue' ? 0.5 : 1
  const youDid = (toThem ?? []).reduce((s, c) => s + weight(c), 0)
  const theyDid = (fromThem ?? []).reduce((s, c) => s + weight(c), 0)
  const total = youDid + theyDid
  if (total === 0) return 0
  return clampScore((theyDid - youDid) / total)
}

function commitmentExists(
  list: RelationshipCommitmentRecord[],
  candidate: RelationshipCommitmentRecord,
): boolean {
  const key = candidate.action.toLowerCase().trim()
  const due = candidate.due ?? ''
  return list.some(
    (c) => c.action.toLowerCase().trim() === key && (c.due ?? '') === due,
  )
}

function milestoneExists(
  list: RelationshipMilestone[] | null | undefined,
  text: string,
  date: string,
): boolean {
  const key = text.toLowerCase().trim()
  return (list ?? []).some(
    (m) => m.event.toLowerCase().trim() === key && m.date === date,
  )
}

function trimLedger(list: RelationshipCommitmentRecord[]): RelationshipCommitmentRecord[] {
  return list
    .sort((a, b) => (a.date_promised < b.date_promised ? 1 : -1))
    .slice(0, MAX_COMMITMENTS_PER_LIST)
}

function deriveStatus(due: string | null): 'pending' | 'overdue' | 'completed' {
  if (!due) return 'pending'
  const dueAt = new Date(due).getTime()
  if (!Number.isFinite(dueAt)) return 'pending'
  return dueAt < Date.now() ? 'overdue' : 'pending'
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < -1) return -1
  if (n > 1) return 1
  return Number(n.toFixed(4))
}

function labelFromScore(score: number): string {
  if (score >= 0.4) return 'warm'
  if (score >= 0.1) return 'positive'
  if (score <= -0.4) return 'tense'
  if (score <= -0.1) return 'cool'
  return 'neutral'
}
