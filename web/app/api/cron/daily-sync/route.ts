import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { getValidAccessTokenForUser } from '../../../../lib/google/oauth'
import {
  fetchAndStoreGmail,
  extractAndStoreCommitments,
} from '../../../../lib/google/gmail-sync'
import { syncCalendarForUser } from '../../../../lib/google/calendar-sync'
import { syncTasksForUser } from '../../../../lib/google/tasks-sync'
import { buildDailyBriefing } from '../../../../lib/intelligence/daily-briefing'
import { computeUserProfile } from '../../../../lib/intelligence/compute-profiles'
import { computeRelationshipEdges } from '../../../../lib/intelligence/compute-relationships'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// GET /api/cron/daily-sync
//
// Vercel cron entry point. Runs the morning sync chain for every connected
// user in user_integrations(provider='google'):
//   1. Pull recent Gmail and extract commitments
//   2. Pull upcoming Calendar events into calendar_events
//   3. Mirror Google Tasks into commitments
//   4. Generate today's daily briefing
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>` when
// CRON_SECRET is set. We also accept `?secret=<CRON_SECRET>` for manual
// kicks. Without CRON_SECRET set the route refuses to run.
export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return apiError(
      500,
      'CRON_SECRET is not configured.',
      undefined,
      'no_cron_secret',
    )
  }

  const auth = req.headers.get('authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  const querySecret = new URL(req.url).searchParams.get('secret') ?? ''
  if (bearer !== expected && querySecret !== expected) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const service = getServiceClient()
  if (!service) {
    return apiError(
      500,
      'Service role key not configured.',
      undefined,
      'no_service_key',
    )
  }

  // Find every connected user. The single-user beta has exactly one row;
  // looping makes this naturally multi-tenant when we onboard more.
  const { data: integrations, error: integErr } = await service
    .from('user_integrations')
    .select('user_id, account_email')
    .eq('provider', 'google')
    .not('refresh_token', 'is', null)

  if (integErr) {
    return apiError(
      500,
      `Failed to list integrations: ${integErr.message}`,
      undefined,
      'integrations_query_failed',
    )
  }

  type Row = { user_id: string; account_email: string | null }
  const users = (integrations ?? []) as Row[]

  const results: Array<{
    user_id: string
    ok: boolean
    gmail?: unknown
    extract?: unknown
    calendar?: unknown
    tasks?: unknown
    profile?: { computed: boolean; top_contacts: number }
    edges?: { computed: number }
    briefing?: { briefing_date: string; counts: Record<string, number> }
    error?: string
  }> = []

  for (const u of users) {
    try {
      const tok = await getValidAccessTokenForUser(u.user_id)
      if ('error' in tok) {
        results.push({
          user_id: u.user_id,
          ok: false,
          error: 'token_lookup_failed',
        })
        continue
      }

      const userEmail = u.account_email ?? ''

      const gmail = await fetchAndStoreGmail(
        service,
        u.user_id,
        userEmail,
        tok.token,
        { days: 7, max: 25 },
      )
      const extract = await extractAndStoreCommitments(
        service,
        u.user_id,
        userEmail,
        gmail.messages,
      )
      const calendar = await syncCalendarForUser(
        service,
        u.user_id,
        tok.token,
        { pastDays: 1, futureDays: 14 },
      )
      const tasks = await syncTasksForUser(
        service,
        u.user_id,
        tok.token,
        { includeCompleted: true },
      )

      // AIEA Layer 1 (Observation): compute behavioral profile + relationship
      // edges from the freshly synced data so the briefing LLM can reason
      // over current signals.
      let profileSummary: { computed: boolean; top_contacts: number } = {
        computed: false,
        top_contacts: 0,
      }
      let edgesSummary: { computed: number } = { computed: 0 }
      try {
        const profile = await computeUserProfile(service, u.user_id)
        profileSummary = {
          computed: true,
          top_contacts: profile.top_contacts.length,
        }
      } catch (err) {
        console.error('[cron daily-sync] computeUserProfile failed', {
          user_id: u.user_id,
          message: err instanceof Error ? err.message : String(err),
        })
      }
      try {
        const edges = await computeRelationshipEdges(service, u.user_id)
        edgesSummary = { computed: edges.length }
      } catch (err) {
        console.error('[cron daily-sync] computeRelationshipEdges failed', {
          user_id: u.user_id,
          message: err instanceof Error ? err.message : String(err),
        })
      }

      const briefing = await buildDailyBriefing(service, u.user_id)
      const { error: briefingErr } = await service
        .from('daily_briefings')
        .upsert(
          {
            user_id: u.user_id,
            briefing_date: briefing.payload.briefing_date,
            payload: briefing.payload,
            markdown: briefing.markdown,
            generated_at: briefing.payload.generated_at,
          },
          { onConflict: 'user_id,briefing_date' },
        )

      // Touch the unified Google integration row so the Settings UI shows a
      // fresh sync timestamp after the cron runs.
      await service
        .from('user_integrations')
        .update({ last_synced_at: new Date().toISOString() })
        .eq('user_id', u.user_id)
        .eq('provider', 'google')

      results.push({
        user_id: u.user_id,
        ok: !briefingErr,
        gmail: {
          fetched: gmail.fetched,
          imported: gmail.imported,
          skipped: gmail.skipped,
          errors: gmail.errors,
        },
        extract: {
          processed: extract.processed,
          skipped: extract.skipped,
          errors: extract.errors,
          commitments_created: extract.commitments_created,
        },
        calendar: {
          fetched: calendar.fetched,
          upserted: calendar.upserted,
          errors: calendar.errors,
        },
        tasks: {
          fetched: tasks.fetched,
          upserted: tasks.upserted,
          errors: tasks.errors,
        },
        profile: profileSummary,
        edges: edgesSummary,
        briefing: {
          briefing_date: briefing.payload.briefing_date,
          counts: briefing.payload.counts,
        },
        error: briefingErr?.message,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      console.error('[cron daily-sync] user failed', {
        user_id: u.user_id,
        message,
      })
      results.push({ user_id: u.user_id, ok: false, error: message })
    }
  }

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    ran_at: new Date().toISOString(),
    user_count: users.length,
    results,
  })
}
