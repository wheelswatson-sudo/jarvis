import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Commitment,
  Contact,
  EventRow,
  ExperienceCapsule,
  Interaction,
  PatternType,
} from '../types'
import {
  COMMITMENT,
  CONFIDENCE_DECAY_THRESHOLD,
  CONFIDENCE_PROMOTION_THRESHOLD,
  ENGAGEMENT,
  PRIORITY,
  RELATIONSHIP_DECAY,
  SAMPLE_SIZE_PROMOTION_THRESHOLD,
  TIMING,
  WINDOWS,
} from './config'
import { logSystemEvent } from './system-health'

// ---------------------------------------------------------------------------
// Experience engine
//
// Reads the user's events + relationship data, runs every pattern detector,
// and persists the result as experience_capsules. Promotion logic:
//
//   emerging  → confirmed   when sample_size >= 5 AND confidence >= 0.45
//   confirmed → stale       when recent data contradicts (confidence drops
//                           below 0.30 with sample_size >= 5)
//
// Each detector returns DetectorOutput[] — one per pattern instance found.
// The engine merges, applies promotion/staling, and writes capsules back.
// ---------------------------------------------------------------------------

export type DetectorOutput = {
  pattern_type: PatternType
  pattern_key: string
  pattern_data: Record<string, unknown>
  confidence: number
  sample_size: number
}

export type EngineRun = {
  user_id: string
  detectors_ran: string[]
  patterns_found: number
  capsules_inserted: number
  capsules_updated: number
  capsules_promoted: number
  capsules_staled: number
  duration_ms: number
}

type EngineDataset = {
  events: EventRow[]
  contacts: Pick<Contact, 'id' | 'name' | 'tier' | 'last_interaction_at'>[]
  interactions: Pick<
    Interaction,
    'id' | 'contact_id' | 'channel' | 'direction' | 'occurred_at' | 'summary'
  >[]
  commitments: Pick<
    Commitment,
    'id' | 'contact_id' | 'description' | 'status' | 'created_at' | 'completed_at'
  >[]
}

export async function runEngineForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<EngineRun> {
  const startedAt = performance.now()
  const dataset = await loadDataset(supabase, userId)

  const detectors: Array<{
    name: string
    run: (d: EngineDataset) => DetectorOutput[]
  }> = [
    { name: 'timing', run: detectTimingPatterns },
    { name: 'relationship_decay', run: detectRelationshipDecay },
    { name: 'engagement_clustering', run: detectEngagementClustering },
    { name: 'commitment_patterns', run: detectCommitmentPatterns },
    { name: 'contact_priority', run: detectContactPriority },
  ]

  const allOutputs: DetectorOutput[] = []
  const detectorsRan: string[] = []
  for (const d of detectors) {
    try {
      const out = d.run(dataset)
      allOutputs.push(...out)
      detectorsRan.push(d.name)
    } catch (err) {
      console.warn(`[engine] detector ${d.name} threw:`, err)
    }
  }

  const merge = await persistCapsules(supabase, userId, allOutputs)
  const duration_ms = Math.round(performance.now() - startedAt)

  const summary: EngineRun = {
    user_id: userId,
    detectors_ran: detectorsRan,
    patterns_found: allOutputs.length,
    capsules_inserted: merge.inserted,
    capsules_updated: merge.updated,
    capsules_promoted: merge.promoted,
    capsules_staled: merge.staled,
    duration_ms,
  }

  await logSystemEvent(supabase, {
    event_type: 'analysis_run',
    user_id: userId,
    details: { ...summary } as Record<string, unknown>,
  })

  return summary
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadDataset(
  supabase: SupabaseClient,
  userId: string,
): Promise<EngineDataset> {
  const longCutoff = new Date(
    Date.now() - WINDOWS.long * 24 * 60 * 60 * 1000,
  ).toISOString()

  const [eventsRes, contactsRes, interactionsRes, commitmentsRes] =
    await Promise.all([
      supabase
        .from('events')
        .select('id, user_id, event_type, contact_id, metadata, created_at')
        .eq('user_id', userId)
        .gte('created_at', longCutoff)
        .order('created_at', { ascending: false })
        .limit(5000),
      supabase
        .from('contacts')
        .select('id, name, tier, last_interaction_at')
        .eq('user_id', userId)
        .limit(2000),
      supabase
        .from('interactions')
        .select('id, contact_id, channel, direction, occurred_at, summary')
        .eq('user_id', userId)
        .gte('occurred_at', longCutoff)
        .order('occurred_at', { ascending: false })
        .limit(5000),
      supabase
        .from('commitments')
        .select(
          'id, contact_id, description, status, created_at, completed_at',
        )
        .eq('user_id', userId)
        .gte('created_at', longCutoff)
        .limit(2000),
    ])

  return {
    events: (eventsRes.data ?? []) as EventRow[],
    contacts: (contactsRes.data ?? []) as EngineDataset['contacts'],
    interactions: (interactionsRes.data ?? []) as EngineDataset['interactions'],
    commitments: (commitmentsRes.data ?? []) as EngineDataset['commitments'],
  }
}

// ---------------------------------------------------------------------------
// Detector 1 — Timing intelligence
//
// "When does this user's outreach get responses?"
// We look at outreach_sent events, then check whether an inbound interaction
// from the same contact occurred within 7 days. We bucket by day-of-week of
// the outreach and report any day whose response rate is >1.5x the average.
// ---------------------------------------------------------------------------

function detectTimingPatterns(d: EngineDataset): DetectorOutput[] {
  const outreaches = d.events.filter((e) => e.event_type === 'outreach_sent')
  if (outreaches.length < TIMING.minOutreachSamples) return []

  // Build inbound-interaction lookup by contact.
  const inboundByContact = new Map<string, number[]>()
  for (const ix of d.interactions) {
    if (ix.direction !== 'inbound' || !ix.contact_id) continue
    const list = inboundByContact.get(ix.contact_id) ?? []
    list.push(new Date(ix.occurred_at).getTime())
    inboundByContact.set(ix.contact_id, list)
  }

  type DayBucket = { sent: number; responded: number }
  const dayBuckets: Record<number, DayBucket> = {}
  for (let i = 0; i < 7; i++) dayBuckets[i] = { sent: 0, responded: 0 }

  const responseWindowMs = 7 * 24 * 60 * 60 * 1000

  for (const o of outreaches) {
    const sentAt = new Date(o.created_at).getTime()
    const day = new Date(o.created_at).getUTCDay()
    dayBuckets[day]!.sent++

    if (!o.contact_id) continue
    const inbound = inboundByContact.get(o.contact_id) ?? []
    const responded = inbound.some(
      (t) => t > sentAt && t - sentAt <= responseWindowMs,
    )
    if (responded) dayBuckets[day]!.responded++
  }

  const totalSent = Object.values(dayBuckets).reduce(
    (s, b) => s + b.sent,
    0,
  )
  const totalResponded = Object.values(dayBuckets).reduce(
    (s, b) => s + b.responded,
    0,
  )
  if (totalSent === 0) return []
  const baseline = totalResponded / totalSent

  const dayName = (i: number) =>
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]!

  const out: DetectorOutput[] = []
  for (const [dayStr, bucket] of Object.entries(dayBuckets)) {
    if (bucket.sent < TIMING.minOutreachSamples) continue
    const rate = bucket.responded / bucket.sent
    const lift = baseline > 0 ? rate / baseline : 0
    if (lift < TIMING.liftThreshold) continue
    const day = Number(dayStr)
    out.push({
      pattern_type: 'timing_preference',
      pattern_key: `dow_${day}`,
      pattern_data: {
        day_of_week: day,
        day_name: dayName(day),
        response_rate: Number(rate.toFixed(3)),
        baseline: Number(baseline.toFixed(3)),
        lift: Number(lift.toFixed(2)),
        sent: bucket.sent,
        responded: bucket.responded,
      },
      confidence: clamp01(Math.min(1, (lift - 1) / 2)),
      sample_size: bucket.sent,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Detector 2 — Relationship decay
//
// For each tracked contact, compute the typical cadence (median days between
// interactions) over the lookback. If days-since-last > 2x cadence (or > 60d
// for high-tier contacts with no cadence yet), emit a decay capsule.
// ---------------------------------------------------------------------------

function detectRelationshipDecay(d: EngineDataset): DetectorOutput[] {
  const ixByContact = new Map<
    string,
    { time: number; summary: string | null }[]
  >()
  for (const ix of d.interactions) {
    if (!ix.contact_id) continue
    const list = ixByContact.get(ix.contact_id) ?? []
    list.push({
      time: new Date(ix.occurred_at).getTime(),
      summary: ix.summary ?? null,
    })
    ixByContact.set(ix.contact_id, list)
  }

  const out: DetectorOutput[] = []
  const now = Date.now()

  for (const c of d.contacts) {
    const tier = c.tier ?? 3
    if (tier > 2) continue

    const events = (ixByContact.get(c.id) ?? []).sort(
      (a, b) => a.time - b.time,
    )
    const times = events.map((e) => e.time)
    const lastSeen = c.last_interaction_at
      ? new Date(c.last_interaction_at).getTime()
      : times.length > 0
        ? times[times.length - 1]!
        : null

    if (!lastSeen) continue
    const daysSince = (now - lastSeen) / (24 * 60 * 60 * 1000)

    let cadenceDays: number | null = null
    if (times.length >= 3) {
      const gaps: number[] = []
      for (let i = 1; i < times.length; i++) {
        gaps.push((times[i]! - times[i - 1]!) / (24 * 60 * 60 * 1000))
      }
      gaps.sort((a, b) => a - b)
      cadenceDays = gaps[Math.floor(gaps.length / 2)]!
    }

    const threshold =
      cadenceDays != null
        ? Math.max(
            cadenceDays * RELATIONSHIP_DECAY.cadenceMultiplier,
            14,
          )
        : RELATIONSHIP_DECAY.hardFloorDays

    if (daysSince <= threshold) continue

    const overshoot = daysSince / threshold
    const confidence = clamp01((overshoot - 1) * 0.5 + 0.4)

    const lastSummary = events.length
      ? (events[events.length - 1]!.summary ?? null)
      : null

    out.push({
      pattern_type: 'relationship_decay',
      pattern_key: `decay_${c.id}`,
      pattern_data: {
        contact_id: c.id,
        contact_name: c.name,
        tier,
        days_since: Math.round(daysSince),
        cadence_days: cadenceDays != null ? Math.round(cadenceDays) : null,
        threshold_days: Math.round(threshold),
        overshoot: Number(overshoot.toFixed(2)),
        last_topic: lastSummary,
      },
      confidence,
      sample_size: Math.max(times.length, 1),
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Detector 3 — Engagement clustering
//
// Group contacts that the user views/interacts with on the same calendar day.
// Pairs that co-occur >=3 times suggest a hidden relationship group. We
// surface the top connected components.
// ---------------------------------------------------------------------------

function detectEngagementClustering(d: EngineDataset): DetectorOutput[] {
  const dayBuckets = new Map<string, Set<string>>()
  for (const e of d.events) {
    if (!e.contact_id) continue
    if (
      e.event_type !== 'contact_viewed' &&
      e.event_type !== 'contact_updated' &&
      e.event_type !== 'outreach_sent'
    ) {
      continue
    }
    const day = e.created_at.slice(0, 10)
    const set = dayBuckets.get(day) ?? new Set<string>()
    set.add(e.contact_id)
    dayBuckets.set(day, set)
  }

  // Pair counts.
  const pairs = new Map<string, number>()
  for (const set of dayBuckets.values()) {
    if (set.size < 2 || set.size > 12) continue
    const ids = [...set].sort()
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = `${ids[i]}|${ids[j]}`
        pairs.set(k, (pairs.get(k) ?? 0) + 1)
      }
    }
  }

  // Build adjacency for pairs above threshold.
  const adj = new Map<string, Set<string>>()
  let connections = 0
  for (const [key, count] of pairs) {
    if (count < ENGAGEMENT.coOccurrenceThreshold) continue
    const [a, b] = key.split('|') as [string, string]
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
    connections++
  }
  if (connections === 0) return []

  // Connected components via BFS.
  const seen = new Set<string>()
  const components: string[][] = []
  for (const node of adj.keys()) {
    if (seen.has(node)) continue
    const comp: string[] = []
    const queue = [node]
    while (queue.length) {
      const cur = queue.shift()!
      if (seen.has(cur)) continue
      seen.add(cur)
      comp.push(cur)
      for (const nbr of adj.get(cur) ?? []) {
        if (!seen.has(nbr)) queue.push(nbr)
      }
    }
    if (comp.length >= 2 && comp.length <= ENGAGEMENT.maxClusterSize) {
      components.push(comp)
    }
  }

  const contactName = new Map(d.contacts.map((c) => [c.id, c.name]))

  return components.map((ids, idx) => {
    const sortedIds = ids.slice().sort()
    return {
      pattern_type: 'engagement_pattern' as const,
      pattern_key: `cluster_${sortedIds.slice(0, 6).join('_')}`,
      pattern_data: {
        cluster_index: idx,
        contact_ids: sortedIds,
        contact_names: sortedIds.map((id) => contactName.get(id) ?? null),
        size: sortedIds.length,
      },
      confidence: clamp01(0.4 + 0.1 * sortedIds.length),
      sample_size: sortedIds.length,
    }
  })
}

// ---------------------------------------------------------------------------
// Detector 4 — Commitment patterns
//
// Bucket commitments by inferred "type" (follow-up / intro / reply / task)
// from the description, then compare completion rates.
// ---------------------------------------------------------------------------

function classifyCommitment(desc: string): string {
  const d = desc.toLowerCase()
  if (/intro|introduce|connect\s+\w+\s+with/.test(d)) return 'intro'
  if (/reply|respond|email\s+back|answer/.test(d)) return 'reply'
  if (/follow.?up|circle\s+back|check\s+in/.test(d)) return 'follow-up'
  if (/send|share|forward/.test(d)) return 'send'
  if (/schedule|book|set\s+up/.test(d)) return 'schedule'
  return 'other'
}

function detectCommitmentPatterns(d: EngineDataset): DetectorOutput[] {
  type Bucket = { total: number; completed: number }
  const buckets: Record<string, Bucket> = {}
  for (const c of d.commitments) {
    const t = classifyCommitment(c.description)
    if (!buckets[t]) buckets[t] = { total: 0, completed: 0 }
    buckets[t]!.total++
    if (c.status === 'done') buckets[t]!.completed++
  }

  const totalAll = Object.values(buckets).reduce((s, b) => s + b.total, 0)
  if (totalAll === 0) return []
  const completedAll = Object.values(buckets).reduce(
    (s, b) => s + b.completed,
    0,
  )
  const baseline = completedAll / totalAll

  const out: DetectorOutput[] = []
  for (const [type, bucket] of Object.entries(buckets)) {
    if (bucket.total < COMMITMENT.minSamplesPerBucket) continue
    const rate = bucket.completed / bucket.total
    const delta = rate - baseline
    if (Math.abs(delta) < COMMITMENT.rateDeltaThreshold) continue
    out.push({
      pattern_type: 'outreach_effectiveness',
      pattern_key: `commit_${type}`,
      pattern_data: {
        commitment_type: type,
        completion_rate: Number(rate.toFixed(3)),
        baseline: Number(baseline.toFixed(3)),
        delta: Number(delta.toFixed(3)),
        total: bucket.total,
        completed: bucket.completed,
      },
      confidence: clamp01(0.4 + Math.min(0.5, Math.abs(delta))),
      sample_size: bucket.total,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Detector 5 — Contact priority scoring
//
// Combine interaction frequency, recency, and channel-diversity into a
// single 0-1 priority score per contact. Surface the top N as capsules.
// ---------------------------------------------------------------------------

function detectContactPriority(d: EngineDataset): DetectorOutput[] {
  type Stats = {
    contact_id: string
    contact_name: string | null
    frequency: number
    recencyDays: number | null
    channels: Set<string>
  }
  const stats = new Map<string, Stats>()

  const now = Date.now()
  for (const c of d.contacts) {
    stats.set(c.id, {
      contact_id: c.id,
      contact_name: c.name,
      frequency: 0,
      recencyDays:
        c.last_interaction_at != null
          ? (now - new Date(c.last_interaction_at).getTime()) /
            (24 * 60 * 60 * 1000)
          : null,
      channels: new Set(),
    })
  }
  for (const ix of d.interactions) {
    if (!ix.contact_id) continue
    const s = stats.get(ix.contact_id)
    if (!s) continue
    s.frequency++
    if (ix.channel) s.channels.add(ix.channel)
    const days = (now - new Date(ix.occurred_at).getTime()) / (24 * 60 * 60 * 1000)
    if (s.recencyDays == null || days < s.recencyDays) s.recencyDays = days
  }

  const all = [...stats.values()].filter((s) => s.frequency > 0)
  if (all.length === 0) return []

  const maxFreq = Math.max(...all.map((s) => s.frequency))

  const scored = all.map((s) => {
    const fScore = maxFreq > 0 ? s.frequency / maxFreq : 0
    const rScore =
      s.recencyDays == null
        ? 0
        : Math.max(0, 1 - Math.min(1, s.recencyDays / 60))
    const dScore = Math.min(1, s.channels.size / 3)
    const score =
      fScore * PRIORITY.weights.frequency +
      rScore * PRIORITY.weights.recency +
      dScore * PRIORITY.weights.diversity
    return { ...s, score }
  })

  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, PRIORITY.topN).map((s, rank) => ({
    pattern_type: 'contact_priority' as const,
    pattern_key: `priority_${s.contact_id}`,
    pattern_data: {
      contact_id: s.contact_id,
      contact_name: s.contact_name,
      rank: rank + 1,
      score: Number(s.score.toFixed(3)),
      frequency: s.frequency,
      recency_days:
        s.recencyDays == null ? null : Math.round(s.recencyDays),
      channel_diversity: s.channels.size,
    },
    confidence: clamp01(0.5 + s.score / 2),
    sample_size: s.frequency,
  }))
}

// ---------------------------------------------------------------------------
// Persistence — upsert capsules, apply promotion / staling rules.
// ---------------------------------------------------------------------------

type MergeResult = {
  inserted: number
  updated: number
  promoted: number
  staled: number
}

async function persistCapsules(
  supabase: SupabaseClient,
  userId: string,
  outputs: DetectorOutput[],
): Promise<MergeResult> {
  const result: MergeResult = {
    inserted: 0,
    updated: 0,
    promoted: 0,
    staled: 0,
  }

  // Load existing capsules for this user.
  const { data: existingData } = await supabase
    .from('experience_capsules')
    .select('*')
    .eq('user_id', userId)
  const existing = (existingData ?? []) as ExperienceCapsule[]

  const existingByKey = new Map(
    existing.map((c) => [`${c.pattern_type}::${c.pattern_key}`, c]),
  )
  const seenKeys = new Set<string>()
  const nowIso = new Date().toISOString()

  for (const out of outputs) {
    const key = `${out.pattern_type}::${out.pattern_key}`
    seenKeys.add(key)
    const prev = existingByKey.get(key)

    if (!prev) {
      const newStatus =
        out.confidence >= CONFIDENCE_PROMOTION_THRESHOLD &&
        out.sample_size >= SAMPLE_SIZE_PROMOTION_THRESHOLD
          ? 'confirmed'
          : 'emerging'
      const { error } = await supabase.from('experience_capsules').insert({
        user_id: userId,
        pattern_type: out.pattern_type,
        pattern_key: out.pattern_key,
        pattern_data: out.pattern_data,
        confidence_score: out.confidence,
        sample_size: out.sample_size,
        status: newStatus,
        first_observed_at: nowIso,
        last_confirmed_at: nowIso,
        updated_at: nowIso,
      })
      if (!error) {
        result.inserted++
        if (newStatus === 'confirmed') {
          result.promoted++
          await logSystemEvent(supabase, {
            event_type: 'capsule_promoted',
            user_id: userId,
            details: {
              pattern_type: out.pattern_type,
              pattern_key: out.pattern_key,
              confidence: out.confidence,
              sample_size: out.sample_size,
            },
          })
        }
      }
      continue
    }

    let nextStatus = prev.status
    let promoted = false
    let staled = false

    if (
      (prev.status === 'emerging') &&
      out.confidence >= CONFIDENCE_PROMOTION_THRESHOLD &&
      out.sample_size >= SAMPLE_SIZE_PROMOTION_THRESHOLD
    ) {
      nextStatus = 'confirmed'
      promoted = true
    } else if (
      (prev.status === 'confirmed' || prev.status === 'deployed') &&
      out.confidence < CONFIDENCE_DECAY_THRESHOLD &&
      out.sample_size >= SAMPLE_SIZE_PROMOTION_THRESHOLD
    ) {
      nextStatus = 'stale'
      staled = true
    } else if (prev.status === 'stale' && out.confidence >= CONFIDENCE_PROMOTION_THRESHOLD) {
      nextStatus = 'confirmed'
      promoted = true
    }

    const { error } = await supabase
      .from('experience_capsules')
      .update({
        pattern_data: out.pattern_data,
        confidence_score: out.confidence,
        sample_size: out.sample_size,
        status: nextStatus,
        last_confirmed_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', prev.id)

    if (!error) {
      result.updated++
      if (promoted) {
        result.promoted++
        await logSystemEvent(supabase, {
          event_type: 'capsule_promoted',
          user_id: userId,
          details: {
            capsule_id: prev.id,
            pattern_type: out.pattern_type,
            pattern_key: out.pattern_key,
            from_status: prev.status,
            confidence: out.confidence,
          },
        })
      }
      if (staled) {
        result.staled++
        await logSystemEvent(supabase, {
          event_type: 'capsule_staled',
          user_id: userId,
          details: {
            capsule_id: prev.id,
            pattern_type: out.pattern_type,
            pattern_key: out.pattern_key,
            from_confidence: prev.confidence_score,
            to_confidence: out.confidence,
          },
        })
      }
    }
  }

  // Auto-stale any previously confirmed capsule whose pattern was NOT
  // observed this run — the underlying signal has disappeared.
  for (const prev of existing) {
    const key = `${prev.pattern_type}::${prev.pattern_key}`
    if (seenKeys.has(key)) continue
    if (prev.status !== 'confirmed' && prev.status !== 'deployed') continue
    await supabase
      .from('experience_capsules')
      .update({ status: 'stale', updated_at: nowIso })
      .eq('id', prev.id)
    result.staled++
    await logSystemEvent(supabase, {
      event_type: 'capsule_staled',
      user_id: userId,
      details: {
        capsule_id: prev.id,
        pattern_type: prev.pattern_type,
        pattern_key: prev.pattern_key,
        reason: 'pattern_not_observed_in_run',
      },
    })
  }

  return result
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
