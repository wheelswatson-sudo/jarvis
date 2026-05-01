import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExperienceCapsule, IntelligenceInsight } from '../types'
import {
  ACCEPTANCE_LOOKBACK_DAYS,
  INSIGHT_EXPIRY_DAYS,
  LOW_ACCEPTANCE_THRESHOLD,
} from './config'
import { logSystemEvent } from './system-health'

// ---------------------------------------------------------------------------
// Insight generator
//
// Reads confirmed (or deployed) experience capsules and turns each into a
// human-readable insight row. Deduplication is enforced by a partial unique
// index on (user_id, insight_key) WHERE status = 'pending'. Expired pending
// insights (>14d old, no action) are auto-marked 'expired'.
//
// Self-tuning: if recent acceptance rate is below 20%, we cap how many new
// insights we generate this run.
// ---------------------------------------------------------------------------

export type InsightDraft = {
  capsule_id: string
  insight_type: string
  insight_key: string
  title: string
  description: string
  priority: number
  metadata: Record<string, unknown>
}

export type GeneratorRun = {
  user_id: string
  candidates: number
  inserted: number
  expired: number
  cap_applied: number
  acceptance_rate: number | null
}

export async function generateInsightsForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<GeneratorRun> {
  // Step 1 — expire stale pending insights.
  const expiryCutoff = new Date(
    Date.now() - INSIGHT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const { data: expired, error: expireErr } = await supabase
    .from('intelligence_insights')
    .update({ status: 'expired' })
    .eq('user_id', userId)
    .eq('status', 'pending')
    .lt('created_at', expiryCutoff)
    .select('id')
  if (expireErr) {
    console.warn('[insights] expiry update failed:', expireErr.message)
  }

  // Step 2 — measure acceptance rate over the lookback window for self-tuning.
  const acceptance = await measureAcceptanceRate(supabase, userId)
  let cap = 25
  let capApplied = 0
  if (acceptance != null && acceptance < LOW_ACCEPTANCE_THRESHOLD) {
    cap = 5
    capApplied = 1
    await logSystemEvent(supabase, {
      event_type: 'low_acceptance_rate',
      user_id: userId,
      details: {
        acceptance_rate: acceptance,
        threshold: LOW_ACCEPTANCE_THRESHOLD,
        new_cap: cap,
      },
    })
    await logSystemEvent(supabase, {
      event_type: 'parameter_tuned',
      user_id: userId,
      details: {
        parameter: 'insight_cap_per_run',
        from: 25,
        to: cap,
        reason: 'low_acceptance_rate',
      },
    })
  }

  // Step 3 — load confirmed/deployed capsules.
  const { data: capsuleData, error: capErr } = await supabase
    .from('experience_capsules')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['confirmed', 'deployed'])
  if (capErr) {
    console.warn('[insights] capsule load failed:', capErr.message)
    return {
      user_id: userId,
      candidates: 0,
      inserted: 0,
      expired: expired?.length ?? 0,
      cap_applied: capApplied,
      acceptance_rate: acceptance,
    }
  }
  const capsules = (capsuleData ?? []) as ExperienceCapsule[]

  // Step 4 — load currently-pending insights (for dedupe).
  const { data: pendingData } = await supabase
    .from('intelligence_insights')
    .select('insight_key')
    .eq('user_id', userId)
    .eq('status', 'pending')
  const pendingKeys = new Set(
    (pendingData ?? []).map((r) => (r as { insight_key: string }).insight_key),
  )

  // Step 5 — build drafts.
  const drafts = capsules
    .map(buildDraft)
    .filter((d): d is InsightDraft => d !== null)
    .filter((d) => !pendingKeys.has(d.insight_key))

  drafts.sort((a, b) => a.priority - b.priority)
  const toInsert = drafts.slice(0, cap)

  let inserted = 0
  for (const draft of toInsert) {
    const { error } = await supabase.from('intelligence_insights').insert({
      user_id: userId,
      capsule_id: draft.capsule_id,
      insight_type: draft.insight_type,
      insight_key: draft.insight_key,
      title: draft.title,
      description: draft.description,
      priority: draft.priority,
      metadata: draft.metadata,
      status: 'pending',
      expires_at: new Date(
        Date.now() + INSIGHT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
    })
    if (!error) {
      inserted++
      await logSystemEvent(supabase, {
        event_type: 'insight_generated',
        user_id: userId,
        details: {
          capsule_id: draft.capsule_id,
          insight_type: draft.insight_type,
          insight_key: draft.insight_key,
          priority: draft.priority,
        },
      })
    } else if (!error.message.includes('duplicate')) {
      console.warn('[insights] insert failed:', error.message)
    }
  }

  return {
    user_id: userId,
    candidates: drafts.length,
    inserted,
    expired: expired?.length ?? 0,
    cap_applied: capApplied,
    acceptance_rate: acceptance,
  }
}

// ---------------------------------------------------------------------------
// Capsule → insight draft. Returns null when the capsule isn't worth
// surfacing (e.g. priority capsules — they inform the dashboard rather
// than producing a discrete insight card).
// ---------------------------------------------------------------------------

function buildDraft(c: ExperienceCapsule): InsightDraft | null {
  switch (c.pattern_type) {
    case 'timing_preference': {
      const data = c.pattern_data as {
        day_name?: string
        lift?: number
        response_rate?: number
      }
      const dayName = typeof data.day_name === 'string' ? data.day_name : 'this day'
      const lift = typeof data.lift === 'number' ? data.lift : 1
      const rate =
        typeof data.response_rate === 'number'
          ? Math.round(data.response_rate * 100)
          : null
      return {
        capsule_id: c.id,
        insight_type: 'timing_preference',
        insight_key: `timing:${c.pattern_key}`,
        title: `Your ${dayName} outreach lands ${lift.toFixed(1)}x harder`,
        description:
          rate != null
            ? `${dayName} replies hit a ${rate}% response rate — ${lift.toFixed(1)}x your average. Schedule key sends here.`
            : `${dayName} outperforms your other days by ${lift.toFixed(1)}x. Consider batching outreach.`,
        priority: 2,
        metadata: { ...data, confidence: c.confidence_score },
      }
    }

    case 'relationship_decay': {
      const data = c.pattern_data as {
        contact_id?: string
        contact_name?: string
        days_since?: number
        threshold_days?: number
        cadence_days?: number | null
        tier?: number
      }
      if (!data.contact_id || !data.contact_name) return null
      const days = data.days_since ?? 0
      const cadence = data.cadence_days ?? null
      const tier = data.tier ?? 2
      const cadenceText = cadence
        ? `${days}d since you last connected — that's ${(days / cadence).toFixed(1)}x your usual ${cadence}d cadence`
        : `${days}d of silence with a Tier ${tier} contact`
      return {
        capsule_id: c.id,
        insight_type: 'relationship_decay',
        insight_key: `decay:${data.contact_id}`,
        title: `Reach out to ${data.contact_name}`,
        description: `${cadenceText}. A short check-in now keeps the relationship warm.`,
        priority: tier === 1 ? 1 : 2,
        metadata: { ...data, confidence: c.confidence_score },
      }
    }

    case 'engagement_pattern': {
      const data = c.pattern_data as {
        contact_names?: (string | null)[]
        size?: number
      }
      const names = (data.contact_names ?? []).filter(
        (n): n is string => typeof n === 'string',
      )
      if (names.length < 2) return null
      const list =
        names.length <= 3
          ? names.join(', ')
          : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
      return {
        capsule_id: c.id,
        insight_type: 'engagement_pattern',
        insight_key: c.pattern_key,
        title: `Hidden cluster: ${list}`,
        description: `These ${data.size ?? names.length} contacts always show up in your activity together. Consider a shared tag or a group thread.`,
        priority: 3,
        metadata: { ...data, confidence: c.confidence_score },
      }
    }

    case 'outreach_effectiveness': {
      const data = c.pattern_data as {
        commitment_type?: string
        completion_rate?: number
        baseline?: number
        delta?: number
        total?: number
        completed?: number
      }
      const t = data.commitment_type ?? 'this kind of'
      const rate = data.completion_rate
      const delta = data.delta ?? 0
      const baseline = data.baseline ?? 0
      if (rate == null) return null
      const ratePct = Math.round(rate * 100)
      const baselinePct = Math.round(baseline * 100)
      const positive = delta > 0
      return {
        capsule_id: c.id,
        insight_type: 'commitment_pattern',
        insight_key: c.pattern_key,
        title: positive
          ? `You crush ${t} commitments`
          : `${t} commitments slip through`,
        description: positive
          ? `You complete ${ratePct}% of ${t} commitments — ${ratePct - baselinePct}pp above your average. Lean into them.`
          : `Only ${ratePct}% of ${t} commitments get done vs ${baselinePct}% overall. Consider batching or delegating.`,
        priority: positive ? 4 : 2,
        metadata: { ...data, confidence: c.confidence_score },
      }
    }

    case 'contact_priority':
      // Priority capsules feed the dashboard ranking — they don't need
      // their own insight cards.
      return null

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Acceptance rate over the lookback window. Used to throttle generation.
// "Accepted" = acted_on. Dismissed and expired count as not-accepted.
// ---------------------------------------------------------------------------

async function measureAcceptanceRate(
  supabase: SupabaseClient,
  userId: string,
): Promise<number | null> {
  const cutoff = new Date(
    Date.now() - ACCEPTANCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const { data, error } = await supabase
    .from('intelligence_insights')
    .select('status')
    .eq('user_id', userId)
    .gte('created_at', cutoff)
    .in('status', ['acted_on', 'dismissed', 'expired'])
  if (error || !data) return null
  const rows = data as Pick<IntelligenceInsight, 'status'>[]
  if (rows.length < 5) return null
  const accepted = rows.filter((r) => r.status === 'acted_on').length
  return accepted / rows.length
}
