import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { apiError } from '../../../../lib/api-errors'
import type {
  ExperienceCapsule,
  IntelligenceInsight,
  SystemHealthEntry,
} from '../../../../lib/types'

export const dynamic = 'force-dynamic'

// GET /api/intelligence/health
//
// Self-monitoring snapshot. Per-user — RLS scopes capsules and insights.
// system_health_log is internal so we filter by user_id manually.

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString()

  const [capsulesRes, insightsRes, recentInsightsRes, eventsCountRes, logRes] =
    await Promise.all([
      supabase
        .from('experience_capsules')
        .select('status, pattern_type')
        .eq('user_id', user.id),
      supabase
        .from('intelligence_insights')
        .select('status')
        .eq('user_id', user.id),
      supabase
        .from('intelligence_insights')
        .select('status, created_at, acted_on_at')
        .eq('user_id', user.id)
        .gte('created_at', thirtyDaysAgo),
      supabase
        .from('events')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', thirtyDaysAgo),
      supabase
        .from('system_health_log')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ])

  const capsules = (capsulesRes.data ?? []) as Pick<
    ExperienceCapsule,
    'status' | 'pattern_type'
  >[]
  const insights = (insightsRes.data ?? []) as Pick<
    IntelligenceInsight,
    'status'
  >[]
  const recentInsights = (recentInsightsRes.data ?? []) as Pick<
    IntelligenceInsight,
    'status' | 'created_at' | 'acted_on_at'
  >[]
  const log = (logRes.data ?? []) as SystemHealthEntry[]

  const capsuleStatusCounts = countBy(capsules, (c) => c.status)
  const capsuleTypeCounts = countBy(capsules, (c) => c.pattern_type)
  const insightStatusCounts = countBy(insights, (i) => i.status)

  const resolved = recentInsights.filter((i) =>
    ['acted_on', 'dismissed', 'expired'].includes(i.status),
  )
  const acceptedRecent = resolved.filter((i) => i.status === 'acted_on').length
  const acceptanceRate30d =
    resolved.length >= 5 ? acceptedRecent / resolved.length : null

  const lastAnalysis = log.find((l) => l.event_type === 'analysis_run') ?? null

  return NextResponse.json({
    capsules: {
      total: capsules.length,
      by_status: capsuleStatusCounts,
      by_type: capsuleTypeCounts,
    },
    insights: {
      total: insights.length,
      by_status: insightStatusCounts,
      acceptance_rate_30d: acceptanceRate30d,
    },
    events_30d: eventsCountRes.count ?? 0,
    last_analysis: lastAnalysis
      ? {
          at: lastAnalysis.created_at,
          details: lastAnalysis.details,
        }
      : null,
    recent_log: log.map((l) => ({
      event_type: l.event_type,
      details: l.details,
      created_at: l.created_at,
    })),
  })
}

function countBy<T>(items: T[], pick: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const it of items) {
    const k = pick(it)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}
