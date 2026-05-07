// Commitment escalation tiers — a single canonical mapping from "days until /
// past due" to escalation level. Read by the dashboard's "Commitments needing
// action" section. Anything earlier than T-3 is "future" (not yet escalated).
//
//   future      : due > 3 days from now
//   soft        : within 3 days of due_at (T-3 .. T-0)
//   urgent      : just hit due (T+0 .. T+3)
//   escalated   : T+3 .. T+7 overdue
//   critical    : T+7+ overdue

export type EscalationLevel =
  | 'future'
  | 'soft'
  | 'urgent'
  | 'escalated'
  | 'critical'

export type EscalationInfo = {
  level: EscalationLevel
  daysUntilDue: number // negative if overdue
  daysOverdue: number // 0 if not overdue
}

const DAY_MS = 24 * 60 * 60 * 1000

export function getEscalation(
  dueAt: string | null | undefined,
  now: number = Date.now(),
): EscalationInfo | null {
  if (!dueAt) return null
  const due = new Date(dueAt).getTime()
  if (Number.isNaN(due)) return null

  // Floor toward "more urgent": if due_at is partway through today, the
  // commitment counts as due today, not tomorrow.
  const diffDays = Math.floor((due - now) / DAY_MS)
  const daysOverdue = diffDays < 0 ? -diffDays : 0

  let level: EscalationLevel
  if (diffDays > 3) level = 'future'
  else if (diffDays >= 0) level = 'soft'
  else if (daysOverdue <= 3) level = 'urgent'
  else if (daysOverdue <= 7) level = 'escalated'
  else level = 'critical'

  return { level, daysUntilDue: diffDays, daysOverdue }
}

export const ESCALATION_TONE = {
  future: {
    badge: 'bg-white/[0.04] text-zinc-400 ring-1 ring-inset ring-white/[0.06]',
    dot: 'bg-zinc-500',
    label: 'Upcoming',
    weight: 0,
  },
  soft: {
    badge:
      'bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/30',
    dot: 'bg-amber-400',
    label: 'Soon',
    weight: 1,
  },
  urgent: {
    badge: 'bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-500/30',
    dot: 'bg-rose-400',
    label: 'Overdue',
    weight: 2,
  },
  escalated: {
    badge: 'bg-rose-500/15 text-rose-200 ring-1 ring-inset ring-rose-500/40',
    dot: 'bg-rose-400 animate-pulse',
    label: 'Escalated',
    weight: 3,
  },
  critical: {
    badge: 'bg-red-600/15 text-red-200 ring-1 ring-inset ring-red-500/40',
    dot: 'bg-red-500 animate-pulse',
    label: 'Critical',
    weight: 4,
  },
} as const satisfies Record<
  EscalationLevel,
  { badge: string; dot: string; label: string; weight: number }
>

// Sort commitments most-urgent-first. Higher weight = more urgent.
// Within the same level, more-overdue items come first; then closer-to-due.
export function compareEscalation(
  a: EscalationInfo,
  b: EscalationInfo,
): number {
  const wa = ESCALATION_TONE[a.level].weight
  const wb = ESCALATION_TONE[b.level].weight
  if (wa !== wb) return wb - wa
  if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue
  return a.daysUntilDue - b.daysUntilDue
}
