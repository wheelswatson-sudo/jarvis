import type { Tier } from '../types'

// Days between expected contacts for each tier. Inner-circle (T1) is weekly,
// T2 is monthly-ish, T3 is quarterly. These thresholds drive the "overdue"
// badge on the contact detail page and the sort/filter on the contacts grid.
const CADENCE_DAYS: Record<1 | 2 | 3, number> = {
  1: 10,
  2: 35,
  3: 100,
}

const CADENCE_LABEL: Record<1 | 2 | 3, string> = {
  1: 'Weekly contact',
  2: 'Monthly contact',
  3: 'Quarterly contact',
}

// "Approaching due" lights up at 70% of the cadence — proportional so the
// warning window scales with how strict the tier is.
const APPROACHING_RATIO = 0.7

export type CadenceState =
  | 'on-cadence'
  | 'approaching'
  | 'overdue'
  | 'new'
  | 'unknown'

export type CadenceInfo = {
  tier: Tier | null
  cadenceDays: number | null
  cadenceLabel: string | null
  daysSinceLast: number | null
  state: CadenceState
}

const DAY_MS = 24 * 60 * 60 * 1000

export function getCadenceInfo(
  tier: Tier | null | undefined,
  lastInteractionAt: string | null | undefined,
  now: number = Date.now(),
): CadenceInfo {
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    return {
      tier: tier ?? null,
      cadenceDays: null,
      cadenceLabel: null,
      daysSinceLast: null,
      state: 'unknown',
    }
  }

  const cadenceDays = CADENCE_DAYS[tier]
  const cadenceLabel = CADENCE_LABEL[tier]

  if (!lastInteractionAt) {
    // Tier known but no logged interactions yet (e.g. fresh import). Don't
    // auto-flag as overdue — that paints every freshly imported contact red
    // before they've had a chance to be contacted at all.
    return {
      tier,
      cadenceDays,
      cadenceLabel,
      daysSinceLast: null,
      state: 'new',
    }
  }

  const last = new Date(lastInteractionAt).getTime()
  if (Number.isNaN(last)) {
    return {
      tier,
      cadenceDays,
      cadenceLabel,
      daysSinceLast: null,
      state: 'unknown',
    }
  }

  // Clamp to 0 so a future-dated last_interaction_at (clock skew, future
  // backfill) reads as "just contacted" instead of going negative and looping
  // back into stale buckets.
  const daysSinceLast = Math.max(0, Math.floor((now - last) / DAY_MS))

  let state: CadenceState
  if (daysSinceLast >= cadenceDays) state = 'overdue'
  else if (daysSinceLast >= cadenceDays * APPROACHING_RATIO)
    state = 'approaching'
  else state = 'on-cadence'

  return { tier, cadenceDays, cadenceLabel, daysSinceLast, state }
}

// Tailwind class fragments for badge tone, keyed by state. Centralized so the
// detail page and grid stay visually consistent. `as const` so callers can't
// mutate the lookup at runtime.
export const CADENCE_TONE = {
  'on-cadence': {
    badge:
      'bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/30',
    dot: 'bg-emerald-400',
    label: 'On cadence',
  },
  approaching: {
    badge:
      'bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/30',
    dot: 'bg-amber-400',
    label: 'Approaching due',
  },
  overdue: {
    badge: 'bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-500/30',
    dot: 'bg-rose-400',
    label: 'Overdue',
  },
  new: {
    badge:
      'bg-violet-500/10 text-violet-300 ring-1 ring-inset ring-violet-500/30',
    dot: 'bg-violet-400',
    label: 'New',
  },
  unknown: {
    badge: 'bg-white/[0.04] text-zinc-400 ring-1 ring-inset ring-white/[0.06]',
    dot: 'bg-zinc-500',
    label: 'No tier',
  },
} as const satisfies Record<
  CadenceState,
  { badge: string; dot: string; label: string }
>
