import type { Commitment, Contact, Interaction } from '../lib/types'

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}

export function computeHealth(
  contact: Contact,
  interactions: Interaction[],
  commitments: Commitment[],
): { score: number; label: string; tone: 'emerald' | 'amber' | 'red' | 'zinc' } {
  if (contact.relationship_score != null) {
    const s = clamp01(contact.relationship_score)
    return scoreToBucket(s)
  }
  const now = Date.now()
  const lastTs = contact.last_interaction_at
    ? new Date(contact.last_interaction_at).getTime()
    : interactions[0]
      ? new Date(interactions[0].occurred_at).getTime()
      : null
  const daysSince = lastTs
    ? (now - lastTs) / (24 * 60 * 60 * 1000)
    : Infinity

  const recency = clamp01(1 - Math.min(1, daysSince / 60))
  const frequency = clamp01(interactions.length / 12)
  const open = commitments.filter((c) => c.status === 'open')
  const overdue = open.filter(
    (c) => c.due_at && new Date(c.due_at).getTime() < now,
  )
  const followThrough = open.length > 0
    ? clamp01(1 - overdue.length / open.length)
    : 0.6

  const score = clamp01(
    recency * 0.5 + frequency * 0.25 + followThrough * 0.25,
  )
  return scoreToBucket(score)
}

function scoreToBucket(s: number) {
  if (s >= 0.7) return { score: s, label: 'Strong', tone: 'emerald' as const }
  if (s >= 0.45) return { score: s, label: 'Healthy', tone: 'amber' as const }
  if (s >= 0.2) return { score: s, label: 'Cooling', tone: 'amber' as const }
  return { score: s, label: 'Cold', tone: 'red' as const }
}

const TONE_FILL: Record<string, string> = {
  emerald: 'bg-gradient-to-r from-emerald-400 to-teal-400',
  amber: 'bg-gradient-to-r from-amber-400 to-fuchsia-400',
  red: 'bg-gradient-to-r from-red-500 to-fuchsia-500',
  zinc: 'bg-zinc-700',
}
const TONE_TEXT: Record<string, string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  red: 'text-red-300',
  zinc: 'text-zinc-400',
}

export function RelationshipHealthBar({
  contact,
  interactions,
  commitments,
}: {
  contact: Contact
  interactions: Interaction[]
  commitments: Commitment[]
}) {
  const { score, label, tone } = computeHealth(contact, interactions, commitments)
  const pct = Math.round(score * 100)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-sm">
        <span className={`font-medium ${TONE_TEXT[tone]}`}>{label}</span>
        <span className="tabular-nums text-zinc-400">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className={`h-full rounded-full shadow-[0_0_8px_rgba(139,92,246,0.4)] transition-[width] duration-700 ${TONE_FILL[tone]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
