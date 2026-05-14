import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError, apiServerError } from '../../../../lib/api-errors'
import type { PersonalDetails, RelationshipSentimentPoint, Tier } from '../../../../lib/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/contacts/compute-scores
//
// Multi-signal relationship scoring + Dunbar tier assignment.
//
// Composite = geometric mean of available 0-1 signals:
//   - email_frequency      emails(30d) / max(emails(30d) across user's contacts)
//   - sentiment_trend      avg(emotional_trajectory.score) → mapped to 0-1
//   - commitment_completion completed / total commitments (both ledgers)
//   - recency              exp-decay over days-since-last-interaction (half-life 14d)
//
// Geometric mean ignores signals with no data, so a contact with only
// recency data still gets scored — but a single very-low signal pulls the
// composite down sharply, which is what we want.
//
// Tier (Dunbar layers):
//   T1  inner 5    score >= 0.8  AND  interaction within 7d
//   T2  close 15   score >= 0.5  AND  interaction within 30d
//   T3  active 50  score >= 0.3  AND  interaction within 90d
//   T4  outer      everyone else (stored as null tier — schema is 1|2|3)

const HALF_LIFE_DAYS = 14
const FREQUENCY_WINDOW_DAYS = 30

type ContactRow = {
  id: string
  last_interaction_at: string | null
  personal_details: PersonalDetails | null
}

type InteractionRow = {
  contact_id: string | null
  occurred_at: string
}

type ScoreSummary = {
  scored: number
  tier_distribution: { T1: number; T2: number; T3: number; T4: number }
  duration_ms: number
}

export async function POST() {
  const started = performance.now()
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) {
    return apiServerError(
      'contacts.compute-scores.POST',
      new Error('Service role key not configured'),
      'no_service_key',
    )
  }

  const now = Date.now()
  const frequencyCutoff = new Date(
    now - FREQUENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const [contactsRes, interactionsRes] = await Promise.all([
    service
      .from('contacts')
      .select('id, last_interaction_at, personal_details')
      .eq('user_id', user.id)
      .limit(5000),
    service
      .from('interactions')
      .select('contact_id, occurred_at')
      .eq('user_id', user.id)
      .gte('occurred_at', frequencyCutoff)
      .limit(20000),
  ])

  if (contactsRes.error) {
    return apiServerError('contacts.compute-scores.POST', contactsRes.error, 'query_failed')
  }
  if (interactionsRes.error) {
    return apiServerError('contacts.compute-scores.POST', interactionsRes.error, 'query_failed')
  }

  const contacts = (contactsRes.data ?? []) as ContactRow[]
  const interactions = (interactionsRes.data ?? []) as InteractionRow[]

  // ---- per-contact email-frequency in window ----
  const freqByContact = new Map<string, number>()
  for (const ix of interactions) {
    if (!ix.contact_id) continue
    freqByContact.set(ix.contact_id, (freqByContact.get(ix.contact_id) ?? 0) + 1)
  }
  const maxFreq = Math.max(0, ...Array.from(freqByContact.values()))

  const distribution = { T1: 0, T2: 0, T3: 0, T4: 0 }
  let scoredCount = 0

  // Build all updates first, then dispatch in parallel batches. Sequential
  // updates blow past Vercel's 60s budget for power users with thousands
  // of contacts.
  type Plan = { id: string; relationship_score: number; tier: Tier | null }
  const plans: Plan[] = []
  for (const c of contacts) {
    const pd = c.personal_details ?? {}
    const signals: number[] = []

    if (maxFreq > 0) {
      const f = freqByContact.get(c.id) ?? 0
      // Use a small floor so contacts with zero recent emails still
      // contribute (very small) signal rather than being ignored.
      signals.push(Math.max(0.001, f / maxFreq))
    }

    const trend = sentimentTrend(pd.emotional_trajectory ?? null)
    if (trend != null) signals.push(trend)

    const completion = commitmentCompletion(pd)
    if (completion != null) signals.push(completion)

    const recency = recencySignal(c.last_interaction_at, now)
    if (recency != null) signals.push(recency)

    const composite = geometricMean(signals)
    const tier = classifyTier(composite, c.last_interaction_at, now)

    distribution[tier === 1 ? 'T1' : tier === 2 ? 'T2' : tier === 3 ? 'T3' : 'T4']++

    plans.push({
      id: c.id,
      relationship_score: composite,
      tier: tier === 4 ? null : (tier as Tier),
    })
  }

  const BATCH_SIZE = 50
  for (let i = 0; i < plans.length; i += BATCH_SIZE) {
    const batch = plans.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map((p) =>
        service
          .from('contacts')
          .update({ relationship_score: p.relationship_score, tier: p.tier })
          .eq('id', p.id)
          .eq('user_id', user.id),
      ),
    )
    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      if (r.error) {
        console.warn('[compute-scores] update failed', {
          contact_id: batch[j]?.id,
          message: r.error.message,
        })
        continue
      }
      scoredCount++
    }
  }

  const summary: ScoreSummary = {
    scored: scoredCount,
    tier_distribution: distribution,
    duration_ms: Math.round(performance.now() - started),
  }

  return NextResponse.json({ ok: true, ...summary })
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

function sentimentTrend(
  trajectory: RelationshipSentimentPoint[] | null,
): number | null {
  if (!trajectory || trajectory.length === 0) return null
  // Consider only the most recent 10 points so old data doesn't dominate.
  const recent = trajectory.slice(-10)
  let sum = 0
  let count = 0
  for (const p of recent) {
    if (Number.isFinite(p.score)) {
      sum += p.score
      count++
    }
  }
  if (count === 0) return null
  // sentiment is in [-1, 1]; remap to [0, 1].
  const avg = sum / count
  return clamp01((avg + 1) / 2)
}

function commitmentCompletion(pd: PersonalDetails): number | null {
  // Until a completion lifecycle is wired up, treat 'pending' as in-progress
  // (partial credit), 'completed' as full credit, and 'overdue' as zero.
  // This way contacts with commitments don't get tanked to ~0 by a missing
  // completion signal.
  const lists = [
    pd.active_commitments_to_them ?? [],
    pd.active_commitments_from_them ?? [],
  ]
  let weighted = 0
  let total = 0
  for (const list of lists) {
    for (const c of list) {
      total++
      if (c.status === 'completed') weighted += 1
      else if (c.status === 'overdue') weighted += 0
      else weighted += 0.5
    }
  }
  if (total === 0) return null
  return clamp01(weighted / total)
}

function recencySignal(
  lastInteractionAt: string | null,
  now: number,
): number | null {
  if (!lastInteractionAt) return null
  const ts = new Date(lastInteractionAt).getTime()
  if (!Number.isFinite(ts)) return null
  const days = Math.max(0, (now - ts) / (24 * 60 * 60 * 1000))
  // 2^(-days/half_life) — 1.0 today, 0.5 at 14d, 0.25 at 28d, ...
  const v = Math.pow(2, -days / HALF_LIFE_DAYS)
  return clamp01(v)
}

function geometricMean(signals: number[]): number {
  if (signals.length === 0) return 0
  // Floor each component so a single zero doesn't collapse the whole product.
  const FLOOR = 0.0001
  let logSum = 0
  for (const s of signals) {
    logSum += Math.log(Math.max(FLOOR, s))
  }
  const mean = Math.exp(logSum / signals.length)
  return Number(clamp01(mean).toFixed(4))
}

function classifyTier(
  score: number,
  lastInteractionAt: string | null,
  now: number,
): 1 | 2 | 3 | 4 {
  const lastTs = lastInteractionAt
    ? new Date(lastInteractionAt).getTime()
    : null
  const daysSince =
    lastTs && Number.isFinite(lastTs)
      ? (now - lastTs) / (24 * 60 * 60 * 1000)
      : Number.POSITIVE_INFINITY

  if (score >= 0.8 && daysSince <= 7) return 1
  if (score >= 0.5 && daysSince <= 30) return 2
  if (score >= 0.3 && daysSince <= 90) return 3
  return 4
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
