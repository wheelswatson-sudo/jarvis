import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Per-contact rollup metrics
//
// sentiment_trajectory  — least-squares slope (per-day) over the last
//                         TRAJECTORY_WINDOW interactions that carry a numeric
//                         sentiment. Positive = warming, negative = cooling.
//                         Null when there aren't enough samples (<3).
//
// reciprocity_ratio     — inbound / outbound interaction counts over the
//                         RECIPROCITY_WINDOW_DAYS rolling window. Null when
//                         there's no outbound traffic in the window. 1.0 =
//                         balanced; <1 means the user reaches out more; >1
//                         means the contact reaches out more.
// ---------------------------------------------------------------------------

const TRAJECTORY_WINDOW = 10
const TRAJECTORY_LOOKBACK_DAYS = 180
const RECIPROCITY_WINDOW_DAYS = 90
const MIN_TRAJECTORY_SAMPLES = 3

type InteractionRow = {
  contact_id: string | null
  direction: 'inbound' | 'outbound' | null
  sentiment: number | null
  occurred_at: string
}

export type ComputeRun = {
  user_id: string
  contacts_evaluated: number
  contacts_updated: number
  duration_ms: number
}

export async function computeContactMetricsForUser(
  service: SupabaseClient,
  userId: string,
): Promise<ComputeRun> {
  const startedAt = performance.now()

  const trajectoryCutoff = new Date(
    Date.now() - TRAJECTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const reciprocityCutoff = new Date(
    Date.now() - RECIPROCITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const [contactsRes, interactionsRes] = await Promise.all([
    service.from('contacts').select('id').eq('user_id', userId).limit(5000),
    service
      .from('interactions')
      .select('contact_id, direction, sentiment, occurred_at')
      .eq('user_id', userId)
      .gte('occurred_at', trajectoryCutoff)
      .order('occurred_at', { ascending: false })
      .limit(20000),
  ])

  if (contactsRes.error) throw contactsRes.error
  if (interactionsRes.error) throw interactionsRes.error

  const contactIds = (contactsRes.data ?? []).map(
    (r) => (r as { id: string }).id,
  )
  const ixs = (interactionsRes.data ?? []) as InteractionRow[]

  const byContact = new Map<string, InteractionRow[]>()
  for (const ix of ixs) {
    if (!ix.contact_id) continue
    const list = byContact.get(ix.contact_id) ?? []
    list.push(ix)
    byContact.set(ix.contact_id, list)
  }

  const nowIso = new Date().toISOString()
  let updated = 0

  for (const contactId of contactIds) {
    const all = byContact.get(contactId) ?? []
    const trajectory = computeSentimentTrajectory(all)
    const reciprocity = computeReciprocityRatio(all, reciprocityCutoff)

    const { error } = await service
      .from('contacts')
      .update({
        sentiment_trajectory: trajectory,
        reciprocity_ratio: reciprocity,
        metrics_computed_at: nowIso,
      })
      .eq('id', contactId)
      .eq('user_id', userId)

    if (error) {
      console.warn('[contact-metrics] update failed', {
        contact_id: contactId,
        message: error.message,
      })
      continue
    }
    updated++
  }

  return {
    user_id: userId,
    contacts_evaluated: contactIds.length,
    contacts_updated: updated,
    duration_ms: Math.round(performance.now() - startedAt),
  }
}

// ---------------------------------------------------------------------------
// Sentiment trajectory — least-squares slope of sentiment over time.
// x is days-since-the-oldest-sample-in-the-window so the unit is per-day.
// ---------------------------------------------------------------------------
function computeSentimentTrajectory(rows: InteractionRow[]): number | null {
  // rows arrive newest-first; we want the most-recent N with sentiment.
  const samples: { t: number; s: number }[] = []
  for (const r of rows) {
    if (typeof r.sentiment !== 'number' || Number.isNaN(r.sentiment)) continue
    samples.push({
      t: new Date(r.occurred_at).getTime(),
      s: r.sentiment,
    })
    if (samples.length >= TRAJECTORY_WINDOW) break
  }
  if (samples.length < MIN_TRAJECTORY_SAMPLES) return null

  // Re-base x on the oldest sample and convert to days.
  const t0 = Math.min(...samples.map((p) => p.t))
  const xs = samples.map((p) => (p.t - t0) / (24 * 60 * 60 * 1000))
  const ys = samples.map((p) => p.s)

  const n = samples.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n

  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX
    num += dx * (ys[i]! - meanY)
    den += dx * dx
  }
  if (den === 0) return null
  const slope = num / den
  if (!Number.isFinite(slope)) return null
  return Number(slope.toFixed(6))
}

// ---------------------------------------------------------------------------
// Reciprocity ratio — inbound count / outbound count over the rolling window.
// ---------------------------------------------------------------------------
function computeReciprocityRatio(
  rows: InteractionRow[],
  cutoffIso: string,
): number | null {
  let inbound = 0
  let outbound = 0
  for (const r of rows) {
    if (r.occurred_at < cutoffIso) continue
    if (r.direction === 'inbound') inbound++
    else if (r.direction === 'outbound') outbound++
  }
  if (outbound === 0) {
    // No outbound: ratio is undefined. Inbound-only means they're reaching
    // for you exclusively, but we'd rather surface that as a special signal
    // than as a +Infinity ratio.
    return inbound > 0 ? null : null
  }
  return Number((inbound / outbound).toFixed(3))
}
