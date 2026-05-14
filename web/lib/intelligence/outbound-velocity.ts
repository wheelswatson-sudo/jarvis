// ---------------------------------------------------------------------------
// loadOutboundVelocity — "how busy am I being relative to baseline?"
//
// Compares this week's outbound message count to a 4-week trailing
// baseline. Surfaces on /home as a small metric card with a direction
// chip (spiking / steady / slowing). Not a forgotten-loop and not an
// alert — just a self-awareness mirror.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'

const WINDOW_DAYS = 7
const BASELINE_WEEKS = 4
const DAY_MS = 24 * 60 * 60 * 1000
const SPIKE_RATIO = 1.4
const SLOW_RATIO = 0.7

export type OutboundDirection = 'spiking' | 'steady' | 'slowing' | 'no_baseline'

export type OutboundVelocity = {
  this_week_count: number
  baseline_avg_per_week: number | null
  ratio: number | null
  direction: OutboundDirection
}

export async function loadOutboundVelocity(
  service: SupabaseClient,
  userId: string,
  opts?: { now?: Date },
): Promise<OutboundVelocity> {
  const now = opts?.now ?? new Date()
  const baselineStartIso = new Date(
    now.getTime() - (BASELINE_WEEKS + 1) * WINDOW_DAYS * DAY_MS,
  ).toISOString()
  const thisWeekStartIso = new Date(
    now.getTime() - WINDOW_DAYS * DAY_MS,
  ).toISOString()

  const { data, error } = await service
    .from('messages')
    .select('sent_at')
    .eq('user_id', userId)
    .eq('direction', 'outbound')
    .gte('sent_at', baselineStartIso)
    .limit(10000)

  if (error) {
    return emptyVelocity()
  }
  const messages = (data ?? []) as { sent_at: string }[]
  const thisWeekStartTs = new Date(thisWeekStartIso).getTime()
  const baselineStartTs = new Date(baselineStartIso).getTime()

  let thisWeekCount = 0
  let baselineCount = 0
  for (const m of messages) {
    const ts = new Date(m.sent_at).getTime()
    if (!Number.isFinite(ts)) continue
    if (ts >= thisWeekStartTs) {
      thisWeekCount++
    } else if (ts >= baselineStartTs) {
      baselineCount++
    }
  }

  if (baselineCount === 0) {
    // No baseline data yet — show only the raw count.
    return {
      this_week_count: thisWeekCount,
      baseline_avg_per_week: null,
      ratio: null,
      direction: 'no_baseline',
    }
  }

  const baselineAvg = baselineCount / BASELINE_WEEKS
  const ratio = baselineAvg > 0 ? thisWeekCount / baselineAvg : null
  const direction: OutboundDirection =
    ratio == null
      ? 'no_baseline'
      : ratio >= SPIKE_RATIO
        ? 'spiking'
        : ratio <= SLOW_RATIO
          ? 'slowing'
          : 'steady'

  return {
    this_week_count: thisWeekCount,
    baseline_avg_per_week: round1(baselineAvg),
    ratio: ratio == null ? null : round2(ratio),
    direction,
  }
}

function emptyVelocity(): OutboundVelocity {
  return {
    this_week_count: 0,
    baseline_avg_per_week: null,
    ratio: null,
    direction: 'no_baseline',
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
