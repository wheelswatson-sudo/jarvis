'use client'

import { useState } from 'react'
import type {
  Commitment,
  Contact,
  Interaction,
  RelationshipScoreComponents,
} from '../lib/types'

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}

export function computeHealth(
  contact: Contact,
  interactions: Interaction[],
  commitments: Commitment[],
): { score: number; label: string; tone: Tone } {
  if (contact.relationship_score != null) {
    const s = clamp01(contact.relationship_score)
    return scoreToBucket(s)
  }
  // Fallback: server compute hasn't run yet. Estimate from what's loaded.
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

type Tone = 'emerald' | 'amber' | 'red' | 'zinc'

function scoreToBucket(s: number): { score: number; label: string; tone: Tone } {
  if (s >= 0.7) return { score: s, label: 'Strong', tone: 'emerald' }
  if (s >= 0.45) return { score: s, label: 'Healthy', tone: 'amber' }
  if (s >= 0.2) return { score: s, label: 'Cooling', tone: 'amber' }
  return { score: s, label: 'Cold', tone: 'red' }
}

const TONE_FILL: Record<Tone, string> = {
  emerald: 'bg-gradient-to-r from-emerald-400 to-teal-400',
  amber: 'bg-gradient-to-r from-amber-400 to-fuchsia-400',
  red: 'bg-gradient-to-r from-red-500 to-fuchsia-500',
  zinc: 'bg-zinc-700',
}
const TONE_TEXT: Record<Tone, string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  red: 'text-red-300',
  zinc: 'text-zinc-400',
}

// Mapping of component keys to display metadata. Order = rendering order.
type ComponentKey = 'recency' | 'frequency' | 'sentiment' | 'follow_through'
type ComponentMeta = {
  label: string
  description: string
  hint: (value: number) => string | null
}

const COMPONENTS: Record<ComponentKey, ComponentMeta> = {
  recency: {
    label: 'Recency',
    description: 'How recently you connected. Decays by half every 14 days.',
    hint: (v) =>
      v < 0.3
        ? 'Send a quick check-in — even one line resets this.'
        : v < 0.6
          ? 'Touching base this week would keep this strong.'
          : null,
  },
  frequency: {
    label: 'Frequency',
    description: 'Recent interactions, normalized against your most-active contact (last 30 days).',
    hint: (v) =>
      v < 0.2
        ? 'This relationship is below your average cadence.'
        : null,
  },
  sentiment: {
    label: 'Sentiment',
    description: 'Average tone of recent exchanges, mapped to 0–100%.',
    hint: (v) =>
      v < 0.4
        ? 'Tone has been cooling. A warmer touchpoint could shift this.'
        : null,
  },
  follow_through: {
    label: 'Follow-through',
    description: 'Share of commitments you and they have closed out.',
    hint: (v) =>
      v < 0.5
        ? 'Open commitments are dragging this down — closing one will lift the score.'
        : null,
  },
}

const COMPONENT_ORDER: ComponentKey[] = [
  'recency',
  'frequency',
  'sentiment',
  'follow_through',
]

function componentTone(value: number): Tone {
  if (value >= 0.7) return 'emerald'
  if (value >= 0.4) return 'amber'
  if (value > 0) return 'red'
  return 'zinc'
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
  const [open, setOpen] = useState(false)
  const { score, label, tone } = computeHealth(contact, interactions, commitments)
  const pct = Math.round(score * 100)

  const components = contact.relationship_score_components ?? null
  const presentComponents = COMPONENT_ORDER.filter(
    (k) => components?.[k] != null,
  )
  const expandable = presentComponents.length > 0
  const computedAt = components?.computed_at ?? null

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        disabled={!expandable}
        aria-expanded={open}
        className={`group block w-full text-left ${
          expandable
            ? 'cursor-pointer rounded-lg -mx-2 px-2 py-1 transition-colors hover:bg-white/[0.03]'
            : 'cursor-default'
        }`}
      >
        <div className="flex items-baseline justify-between text-sm">
          <span className={`font-medium ${TONE_TEXT[tone]}`}>{label}</span>
          <span className="flex items-baseline gap-2 tabular-nums text-zinc-400">
            {pct}%
            {expandable && (
              <span
                aria-hidden="true"
                className={`text-[10px] text-zinc-500 transition-transform ${
                  open ? 'rotate-180' : ''
                }`}
              >
                ▾
              </span>
            )}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
          <div
            className={`h-full rounded-full shadow-[0_0_8px_rgba(139,92,246,0.4)] transition-[width] duration-700 ${TONE_FILL[tone]}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </button>

      {open && expandable && (
        <ComponentBreakdown
          components={components}
          presentKeys={presentComponents}
          computedAt={computedAt}
        />
      )}

      {!expandable && contact.relationship_score == null && (
        <p className="pt-1 text-[11px] text-zinc-500">
          Component breakdown will appear after the first score compute.
        </p>
      )}
    </div>
  )
}

function ComponentBreakdown({
  components,
  presentKeys,
  computedAt,
}: {
  components: RelationshipScoreComponents | null
  presentKeys: ComponentKey[]
  computedAt: string | null
}) {
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      {presentKeys.map((key) => {
        const value = components?.[key]
        if (value == null) return null
        return (
          <ComponentRow
            key={key}
            label={COMPONENTS[key].label}
            description={COMPONENTS[key].description}
            value={value}
            hint={COMPONENTS[key].hint(value)}
          />
        )
      })}
      {computedAt && (
        <p className="pt-1 text-[10px] uppercase tracking-[0.16em] text-zinc-600">
          Computed {formatComputedAt(computedAt)}
        </p>
      )}
    </div>
  )
}

function ComponentRow({
  label,
  description,
  value,
  hint,
}: {
  label: string
  description: string
  value: number
  hint: string | null
}) {
  const pct = Math.round(clamp01(value) * 100)
  const tone = componentTone(value)
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-zinc-200">{label}</span>
        <span className={`tabular-nums ${TONE_TEXT[tone]}`}>{pct}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${TONE_FILL[tone]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-500">{description}</p>
      {hint && <p className="text-[11px] text-violet-300">→ {hint}</p>}
    </div>
  )
}

function formatComputedAt(iso: string): string {
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return ''
  const mins = Math.round((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}
