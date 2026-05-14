// ---------------------------------------------------------------------------
// computeContactScores — composite relationship score + per-component
// breakdown for every contact a user owns.
//
// Composite = geometric mean of available 0-1 signals:
//   - email_frequency       interactions(30d) / max across user's contacts
//   - sentiment_trend       avg(personal_details.emotional_trajectory) → 0-1
//   - commitment_completion completed share of both ledgers
//   - recency               exp-decay over days-since-last-interaction (h-life 14d)
//
// Geometric mean ignores signals with no data, so a contact with only
// recency data still scores — but a single very-low signal pulls the
// composite down sharply.
//
// Tier (Dunbar layers, stored as 1|2|3 or null):
//   T1  inner 5    score >= 0.8  AND  interaction within 7d
//   T2  close 15   score >= 0.5  AND  interaction within 30d
//   T3  active 50  score >= 0.3  AND  interaction within 90d
//   T4  outer      everyone else (null)
//
// Both the user-facing /api/contacts/compute-scores route and the daily
// cron call this directly so there's exactly one scoring implementation.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  PersonalDetails,
  RelationshipScoreComponents,
  RelationshipSentimentPoint,
  Tier,
} from '../types'

const HALF_LIFE_DAYS = 14
const FREQUENCY_WINDOW_DAYS = 30

export type ScoreSummary = {
  scored: number
  tier_distribution: { T1: number; T2: number; T3: number; T4: number }
  snapshots_inserted: number
  duration_ms: number
}

const SNAPSHOT_BATCH_SIZE = 500

type ContactRow = {
  id: string
  last_interaction_at: string | null
  personal_details: PersonalDetails | null
}

type InteractionRow = {
  contact_id: string | null
  occurred_at: string
}

export async function computeContactScores(
  service: SupabaseClient,
  userId: string,
): Promise<ScoreSummary> {
  const started = performance.now()
  const now = Date.now()
  const frequencyCutoff = new Date(
    now - FREQUENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const [contactsRes, interactionsRes] = await Promise.all([
    service
      .from('contacts')
      .select('id, last_interaction_at, personal_details')
      .eq('user_id', userId)
      .limit(5000),
    service
      .from('interactions')
      .select('contact_id, occurred_at')
      .eq('user_id', userId)
      .gte('occurred_at', frequencyCutoff)
      .limit(20000),
  ])

  if (contactsRes.error) throw new Error(`contacts query: ${contactsRes.error.message}`)
  if (interactionsRes.error) throw new Error(`interactions query: ${interactionsRes.error.message}`)

  const contacts = (contactsRes.data ?? []) as ContactRow[]
  const interactions = (interactionsRes.data ?? []) as InteractionRow[]

  const freqByContact = new Map<string, number>()
  for (const ix of interactions) {
    if (!ix.contact_id) continue
    freqByContact.set(ix.contact_id, (freqByContact.get(ix.contact_id) ?? 0) + 1)
  }
  const maxFreq = Math.max(0, ...Array.from(freqByContact.values()))

  const distribution = { T1: 0, T2: 0, T3: 0, T4: 0 }
  let scoredCount = 0

  type Plan = {
    id: string
    relationship_score: number
    tier: Tier | null
    components: RelationshipScoreComponents
  }
  const plans: Plan[] = []
  const computedAt = new Date(now).toISOString()
  for (const c of contacts) {
    const pd = c.personal_details ?? {}
    const signals: number[] = []
    const components: RelationshipScoreComponents = { computed_at: computedAt }

    if (maxFreq > 0) {
      const f = freqByContact.get(c.id) ?? 0
      const v = Math.max(0.001, f / maxFreq)
      signals.push(v)
      components.frequency = round4(v)
    }

    const trend = sentimentTrend(pd.emotional_trajectory ?? null)
    if (trend != null) {
      signals.push(trend)
      components.sentiment = round4(trend)
    }

    const completion = commitmentCompletion(pd)
    if (completion != null) {
      signals.push(completion)
      components.follow_through = round4(completion)
    }

    const recency = recencySignal(c.last_interaction_at, now)
    if (recency != null) {
      signals.push(recency)
      components.recency = round4(recency)
    }

    const composite = geometricMean(signals)
    const tier = classifyTier(composite, c.last_interaction_at, now)
    distribution[tier === 1 ? 'T1' : tier === 2 ? 'T2' : tier === 3 ? 'T3' : 'T4']++

    plans.push({
      id: c.id,
      relationship_score: composite,
      tier: tier === 4 ? null : (tier as Tier),
      components,
    })
  }

  const BATCH_SIZE = 50
  for (let i = 0; i < plans.length; i += BATCH_SIZE) {
    const batch = plans.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map((p) =>
        service
          .from('contacts')
          .update({
            relationship_score: p.relationship_score,
            tier: p.tier,
            relationship_score_components: p.components,
          })
          .eq('id', p.id)
          .eq('user_id', userId),
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

  // Append-only snapshot history. Written AFTER the contacts.update pass so
  // a snapshot row only exists for contacts whose denormalized "latest"
  // also reflects this compute. Failure here doesn't roll back the scores
  // (delta detection degrades gracefully if a snapshot is missing) but we
  // log so cron observability catches systemic write failures.
  let snapshotsInserted = 0
  const snapshotRows = plans.map((p) => ({
    user_id: userId,
    contact_id: p.id,
    composite: p.relationship_score,
    recency: p.components.recency ?? null,
    frequency: p.components.frequency ?? null,
    sentiment: p.components.sentiment ?? null,
    follow_through: p.components.follow_through ?? null,
    computed_at: computedAt,
  }))
  for (let i = 0; i < snapshotRows.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = snapshotRows.slice(i, i + SNAPSHOT_BATCH_SIZE)
    const { error } = await service
      .from('relationship_score_snapshots')
      .insert(batch)
    if (error) {
      console.warn('[compute-scores] snapshot insert failed', {
        user_id: userId,
        batch_start: i,
        batch_size: batch.length,
        message: error.message,
      })
      continue
    }
    snapshotsInserted += batch.length
  }

  return {
    scored: scoredCount,
    tier_distribution: distribution,
    snapshots_inserted: snapshotsInserted,
    duration_ms: Math.round(performance.now() - started),
  }
}

// ---------------------------------------------------------------------------
// Signal helpers — exported for unit testing
// ---------------------------------------------------------------------------

export function sentimentTrend(
  trajectory: RelationshipSentimentPoint[] | null,
): number | null {
  if (!trajectory || trajectory.length === 0) return null
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
  const avg = sum / count
  return clamp01((avg + 1) / 2)
}

export function commitmentCompletion(pd: PersonalDetails): number | null {
  // Treat 'pending' as in-progress (partial credit), 'completed' as full
  // credit, 'overdue' as zero. Keeps a contact from getting tanked to ~0
  // because no completion lifecycle has been wired up yet.
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

export function recencySignal(
  lastInteractionAt: string | null,
  now: number,
): number | null {
  if (!lastInteractionAt) return null
  const ts = new Date(lastInteractionAt).getTime()
  if (!Number.isFinite(ts)) return null
  const days = Math.max(0, (now - ts) / (24 * 60 * 60 * 1000))
  // 2^(-days/half_life) — 1.0 today, 0.5 at 14d, 0.25 at 28d, …
  const v = Math.pow(2, -days / HALF_LIFE_DAYS)
  return clamp01(v)
}

export function geometricMean(signals: number[]): number {
  if (signals.length === 0) return 0
  const FLOOR = 0.0001
  let logSum = 0
  for (const s of signals) {
    logSum += Math.log(Math.max(FLOOR, s))
  }
  const mean = Math.exp(logSum / signals.length)
  return Number(clamp01(mean).toFixed(4))
}

export function classifyTier(
  score: number,
  lastInteractionAt: string | null,
  now: number,
): 1 | 2 | 3 | 4 {
  const lastTs = lastInteractionAt ? new Date(lastInteractionAt).getTime() : null
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

function round4(n: number): number {
  return Number(clamp01(n).toFixed(4))
}
