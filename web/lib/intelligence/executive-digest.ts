// ---------------------------------------------------------------------------
// buildExecutiveDigest — the Friday chief-of-staff memo.
//
// Synthesises 7 days of signals into a short executive narrative the user
// can read in ≤60 seconds. NUMBERS are computed in TS (deterministic, no
// hallucinations); the LLM only writes the qualitative "bottom line" —
// 2-3 sentences naming what to actually do next week.
//
// Structured payload (jsonb) drives:
//   - the /digest page (rich UI render)
//   - the markdown copy (paste-able into email, Slack, Notes)
//   - downstream consumers like a hypothetical "email me the memo" feature
//
// Re-runnable: the cron `upsert`s on (user_id, week_starting) so a manual
// kick after a botched generation just overwrites the row.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getModel,
  getProviderEnvKey,
  streamCompletion,
  type ChatMessage,
  type ModelInfo,
} from '../providers'
import { findForgottenLoops } from './forgotten-loops'
import { findSentimentShifts } from './sentiment-shifts'
import {
  findUpcomingMilestones,
  type UpcomingMilestone,
} from './milestone-radar'

const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'
const FALLBACK_MODEL_ID = 'groq-llama-4-scout'
const MAX_DIGEST_ITEMS = 5
const NARRATIVE_MAX_TOKENS = 350
const DAY_MS = 24 * 60 * 60 * 1000

export type ExecutiveDigestMetrics = {
  total_interactions: number
  inbound: number
  outbound: number
  unique_contacts: number
  meetings_held: number
  commitments_created: number
  commitments_completed: number
  commitments_overdue: number
}

export type RelationshipMove = {
  contact_id: string
  contact_name: string
  delta_pct: number
  current_pct: number
  prior_pct: number
}

export type OpenLoopSummary = {
  contact_id: string
  contact_name: string
  type:
    | 'unreplied_inbound'
    | 'stalled_outbound'
    | 'silent_overdue_commitment'
  days: number
  hint: string
}

export type DueCommitmentSummary = {
  contact_id: string | null
  contact_name: string | null
  description: string
  due_at: string
}

export type DigestMilestone = {
  contact_id: string
  contact_name: string
  kind: 'birthday' | 'milestone'
  label: string
  days_until: number
  next_date: string
}

export type ExecutiveDigestPayload = {
  user_id: string
  week_starting: string // ISO date (Monday)
  week_ending: string // ISO date (Sunday)
  generated_at: string
  metrics: ExecutiveDigestMetrics
  warming: RelationshipMove[]
  cooling: RelationshipMove[]
  open_loops: OpenLoopSummary[]
  due_next_week: DueCommitmentSummary[]
  // Optional — older rows persisted before migration 024+milestones may
  // not have it. Readers must tolerate undefined.
  milestones?: DigestMilestone[]
  narrative: string
  model: string | null
}

export type BuildExecutiveDigestInput = {
  service: SupabaseClient
  userId: string
  userName: string
  // Override "now" for tests / backfills.
  now?: Date
}

export type ExecutiveDigest = {
  payload: ExecutiveDigestPayload
  markdown: string
}

export async function buildExecutiveDigest(
  input: BuildExecutiveDigestInput,
): Promise<ExecutiveDigest> {
  const { service, userId, userName } = input
  const now = input.now ?? new Date()
  const { weekStartIso, weekEndIso, weekStartTs, weekEndTs } =
    weekWindow(now)
  const nextWeekEndIso = new Date(weekEndTs + 7 * DAY_MS).toISOString()

  // ---------------- structured signal gathering ----------------
  const [
    messagesRes,
    meetingsRes,
    weekCommitmentsRes,
    nextWeekCommitmentsRes,
    forgottenLoops,
    sentimentShifts,
    upcomingMilestones,
  ] = await Promise.all([
    service
      .from('messages')
      .select('id, contact_id, direction, sent_at')
      .eq('user_id', userId)
      .gte('sent_at', weekStartIso)
      .lte('sent_at', weekEndIso)
      .limit(5000),
    service
      .from('calendar_events')
      .select('id, start_at')
      .eq('user_id', userId)
      .gte('start_at', weekStartIso)
      .lte('start_at', weekEndIso)
      .limit(500),
    service
      .from('commitments')
      .select(
        'id, contact_id, description, owner, status, due_at, created_at, completed_at',
      )
      .eq('user_id', userId)
      .or(
        [
          `created_at.gte.${weekStartIso}`,
          `completed_at.gte.${weekStartIso}`,
        ].join(','),
      )
      .limit(2000),
    service
      .from('commitments')
      .select('id, contact_id, description, due_at, status')
      .eq('user_id', userId)
      .eq('status', 'open')
      .gte('due_at', weekEndIso)
      .lte('due_at', nextWeekEndIso)
      .order('due_at', { ascending: true })
      .limit(50),
    findForgottenLoops(service, userId).catch(() => []),
    findSentimentShifts(service, userId).catch(() => []),
    // Look forward 14 days from now — that's "next week" in the digest's
    // mental model. The /home radar uses the same default.
    findUpcomingMilestones(service, userId, { lookaheadDays: 14, now }).catch(
      () => [] as UpcomingMilestone[],
    ),
  ])

  type MessageRow = {
    id: string
    contact_id: string | null
    direction: 'inbound' | 'outbound' | null
    sent_at: string
  }
  type CommitmentRow = {
    id: string
    contact_id: string | null
    description: string
    owner: 'me' | 'them' | null
    status: string
    due_at: string | null
    created_at: string
    completed_at: string | null
  }

  const messages = (messagesRes.data ?? []) as MessageRow[]
  const meetings = (meetingsRes.data ?? []) as Array<{
    id: string
    start_at: string
  }>
  const weekCommitments = (weekCommitmentsRes.data ?? []) as CommitmentRow[]
  const nextWeekCommitments = (nextWeekCommitmentsRes.data ?? []) as Array<{
    id: string
    contact_id: string | null
    description: string
    due_at: string | null
    status: string
  }>

  // ---------------- metrics ----------------
  let inbound = 0
  let outbound = 0
  const uniqueContacts = new Set<string>()
  for (const m of messages) {
    if (m.direction === 'inbound') inbound++
    else if (m.direction === 'outbound') outbound++
    if (m.contact_id) uniqueContacts.add(m.contact_id)
  }

  let createdCount = 0
  let completedCount = 0
  let overdueCount = 0
  const nowTs = now.getTime()
  for (const c of weekCommitments) {
    const createdTs = new Date(c.created_at).getTime()
    if (Number.isFinite(createdTs) && createdTs >= weekStartTs && createdTs <= weekEndTs) {
      createdCount++
    }
    if (c.completed_at) {
      const completedTs = new Date(c.completed_at).getTime()
      if (
        Number.isFinite(completedTs) &&
        completedTs >= weekStartTs &&
        completedTs <= weekEndTs
      ) {
        completedCount++
      }
    }
    if (c.status === 'open' && c.due_at) {
      const dueTs = new Date(c.due_at).getTime()
      if (Number.isFinite(dueTs) && dueTs < nowTs) overdueCount++
    }
  }

  const metrics: ExecutiveDigestMetrics = {
    total_interactions: inbound + outbound,
    inbound,
    outbound,
    unique_contacts: uniqueContacts.size,
    meetings_held: meetings.length,
    commitments_created: createdCount,
    commitments_completed: completedCount,
    commitments_overdue: overdueCount,
  }

  // ---------------- relationship moves ----------------
  const warming: RelationshipMove[] = []
  const cooling: RelationshipMove[] = []
  for (const s of sentimentShifts) {
    const move: RelationshipMove = {
      contact_id: s.contact_id,
      contact_name: s.contact_name,
      delta_pct: Math.round(s.delta * 100),
      current_pct: Math.round(s.current * 100),
      prior_pct: Math.round(s.prior * 100),
    }
    if (s.direction === 'warmed') warming.push(move)
    else cooling.push(move)
  }
  warming.sort((a, b) => b.delta_pct - a.delta_pct)
  cooling.sort((a, b) => b.delta_pct - a.delta_pct)

  // ---------------- open loops & due-next-week ----------------
  const openLoops: OpenLoopSummary[] = forgottenLoops
    .slice(0, MAX_DIGEST_ITEMS)
    .map((l) => ({
      contact_id: l.contact_id,
      contact_name: l.contact_name,
      type: l.type,
      days: l.days,
      hint: l.hint,
    }))

  const contactIdsForDue = nextWeekCommitments
    .map((c) => c.contact_id)
    .filter((v): v is string => v !== null)
  const nameById = await loadContactNames(service, userId, contactIdsForDue)
  const dueNextWeek: DueCommitmentSummary[] = nextWeekCommitments
    .slice(0, MAX_DIGEST_ITEMS)
    .map((c) => ({
      contact_id: c.contact_id,
      contact_name: c.contact_id ? nameById.get(c.contact_id) ?? null : null,
      description: c.description,
      due_at: c.due_at ?? '',
    }))

  const milestones: DigestMilestone[] = upcomingMilestones
    .slice(0, MAX_DIGEST_ITEMS)
    .map((m) => ({
      contact_id: m.contact_id,
      contact_name: m.contact_name,
      kind: m.kind,
      label: m.label,
      days_until: m.days_until,
      next_date: m.next_date,
    }))

  // ---------------- LLM narrative ----------------
  const narrativeResult = await synthesizeNarrative({
    userName,
    metrics,
    warming: warming.slice(0, 3),
    cooling: cooling.slice(0, 3),
    openLoops: openLoops.slice(0, 3),
    dueNextWeek: dueNextWeek.slice(0, 3),
    milestones: milestones.slice(0, 3),
  })

  const payload: ExecutiveDigestPayload = {
    user_id: userId,
    week_starting: weekStartIso.slice(0, 10),
    week_ending: weekEndIso.slice(0, 10),
    generated_at: now.toISOString(),
    metrics,
    warming: warming.slice(0, 3),
    cooling: cooling.slice(0, 3),
    open_loops: openLoops,
    due_next_week: dueNextWeek,
    milestones,
    narrative: narrativeResult.text,
    model: narrativeResult.model,
  }

  return {
    payload,
    markdown: renderMarkdown(payload, userName),
  }
}

// ---------------------------------------------------------------------------
// LLM synthesis — narrative only, never the numbers
// ---------------------------------------------------------------------------

type NarrativeInput = {
  userName: string
  metrics: ExecutiveDigestMetrics
  warming: RelationshipMove[]
  cooling: RelationshipMove[]
  openLoops: OpenLoopSummary[]
  dueNextWeek: DueCommitmentSummary[]
  milestones: DigestMilestone[]
}

async function synthesizeNarrative(
  input: NarrativeInput,
): Promise<{ text: string; model: string | null }> {
  const model = await pickModel()
  const apiKey = model ? getProviderEnvKey(model.provider) : undefined
  if (!model || !apiKey) {
    // No LLM available — return a deterministic fallback narrative so the
    // page still renders something useful. Beats throwing on a Friday.
    return { text: deterministicNarrative(input), model: null }
  }

  const system = `You are a chief of staff writing a Friday memo for ${input.userName}.

The reader scans this in under 60 seconds. Output a SHORT executive narrative — 3 to 5 sentences total. Plain prose, no bullet lists, no headers, no markdown.

VOICE
- Direct. Skip platitudes ("great week", "keep up the momentum").
- Lead with the most actionable thing. End with the most important call for next week.
- Use specific names from the data when they sharpen the point — don't invent any.
- If signals are thin, say so plainly. Don't pad.

DO NOT
- Restate the numbers. The reader already sees them.
- Recommend anything that contradicts the provided data.
- Apologize, hedge, or use phrases like "It seems".`

  const userPrompt = `WEEK SIGNALS

Counts: ${input.metrics.total_interactions} interactions (${input.metrics.inbound} in / ${input.metrics.outbound} out) across ${input.metrics.unique_contacts} contacts. ${input.metrics.meetings_held} meetings. Commitments: ${input.metrics.commitments_completed} completed, ${input.metrics.commitments_created} created, ${input.metrics.commitments_overdue} overdue.

Warming relationships (top 3): ${
    input.warming.length === 0
      ? 'none flagged.'
      : input.warming
          .map(
            (w) =>
              `${w.contact_name} (${w.prior_pct}% → ${w.current_pct}%)`,
          )
          .join('; ') + '.'
  }

Cooling relationships (top 3): ${
    input.cooling.length === 0
      ? 'none flagged.'
      : input.cooling
          .map(
            (c) =>
              `${c.contact_name} (${c.prior_pct}% → ${c.current_pct}%)`,
          )
          .join('; ') + '.'
  }

Open loops carrying into next week: ${
    input.openLoops.length === 0
      ? 'none.'
      : input.openLoops.map((l) => l.hint).join(' ')
  }

Commitments due next week: ${
    input.dueNextWeek.length === 0
      ? 'none.'
      : input.dueNextWeek
          .map(
            (d) =>
              `${d.description}${d.contact_name ? ` (${d.contact_name})` : ''}`,
          )
          .join('; ') + '.'
  }

Upcoming milestones (next 14 days): ${
    input.milestones.length === 0
      ? 'none.'
      : input.milestones
          .map(
            (m) =>
              `${m.contact_name} — ${m.kind === 'birthday' ? 'birthday' : m.label}${m.days_until === 0 ? ' today' : m.days_until === 1 ? ' tomorrow' : ` in ${m.days_until}d`}`,
          )
          .join('; ') + '.'
  }

Write the memo.`

  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }]
  let raw = ''
  try {
    for await (const chunk of streamCompletion({
      apiKey,
      model,
      system,
      messages,
      maxTokens: NARRATIVE_MAX_TOKENS,
    })) {
      raw += chunk
    }
  } catch (err) {
    console.error('[executive-digest] LLM call failed', {
      model: model.id,
      message: err instanceof Error ? err.message : String(err),
    })
    return { text: deterministicNarrative(input), model: null }
  }

  const text = raw.trim()
  if (!text) return { text: deterministicNarrative(input), model: null }
  return { text, model: model.id }
}

async function pickModel(): Promise<ModelInfo | null> {
  for (const id of [DEFAULT_MODEL_ID, FALLBACK_MODEL_ID]) {
    const m = getModel(id)
    if (getProviderEnvKey(m.provider)) return m
  }
  return null
}

function deterministicNarrative(input: NarrativeInput): string {
  const parts: string[] = []
  if (input.cooling.length > 0) {
    parts.push(
      `Top cooling relationship is ${input.cooling[0]!.contact_name} (${input.cooling[0]!.prior_pct}% → ${input.cooling[0]!.current_pct}%).`,
    )
  }
  if (input.openLoops.length > 0) {
    parts.push(
      `${input.openLoops.length} open loop${input.openLoops.length === 1 ? '' : 's'} carry into next week.`,
    )
  }
  if (input.dueNextWeek.length > 0) {
    parts.push(`${input.dueNextWeek.length} commitments come due in the next 7 days.`)
  }
  if (parts.length === 0) {
    parts.push('No urgent signals this week. Steady state.')
  }
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Markdown render — paste-able, no surprises
// ---------------------------------------------------------------------------

function renderMarkdown(
  payload: ExecutiveDigestPayload,
  userName: string,
): string {
  const lines: string[] = []
  lines.push(`# Executive digest — week of ${payload.week_starting}`)
  lines.push('')
  lines.push(`_${userName}, here's what your week looked like._`)
  lines.push('')
  lines.push(payload.narrative)
  lines.push('')
  lines.push('## By the numbers')
  const m = payload.metrics
  lines.push(
    `- ${m.total_interactions} interactions (${m.inbound} in · ${m.outbound} out) across ${m.unique_contacts} contacts`,
  )
  lines.push(`- ${m.meetings_held} meetings held`)
  lines.push(
    `- Commitments: ${m.commitments_completed} completed · ${m.commitments_created} new · ${m.commitments_overdue} overdue`,
  )
  if (payload.warming.length > 0 || payload.cooling.length > 0) {
    lines.push('')
    lines.push('## Relationships on the move')
    for (const w of payload.warming) {
      lines.push(
        `- ↑ ${w.contact_name} — warming (${w.prior_pct}% → ${w.current_pct}%)`,
      )
    }
    for (const c of payload.cooling) {
      lines.push(
        `- ↓ ${c.contact_name} — cooling (${c.prior_pct}% → ${c.current_pct}%)`,
      )
    }
  }
  if (payload.open_loops.length > 0) {
    lines.push('')
    lines.push('## Open loops carrying forward')
    for (const l of payload.open_loops) {
      lines.push(`- ${l.hint}`)
    }
  }
  if (payload.due_next_week.length > 0) {
    lines.push('')
    lines.push('## Coming due next week')
    for (const d of payload.due_next_week) {
      const who = d.contact_name ? ` (${d.contact_name})` : ''
      const when = d.due_at
        ? ` — due ${new Date(d.due_at).toLocaleDateString()}`
        : ''
      lines.push(`- ${d.description}${who}${when}`)
    }
  }
  if (payload.milestones && payload.milestones.length > 0) {
    lines.push('')
    lines.push('## On the radar')
    for (const m of payload.milestones) {
      const when =
        m.days_until === 0
          ? 'today'
          : m.days_until === 1
            ? 'tomorrow'
            : `in ${m.days_until}d`
      const label = m.kind === 'birthday' ? 'birthday' : m.label
      lines.push(`- ${m.contact_name} — ${label} (${when})`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Returns the Monday→Sunday window containing `now` (or the most recently
// completed week if `now` is itself a Monday before working hours — we
// always look back, never forward, so a Friday-morning cron summarises
// THIS week's activity through Friday morning).
export function weekWindow(now: Date): {
  weekStartIso: string
  weekEndIso: string
  weekStartTs: number
  weekEndTs: number
} {
  const day = now.getUTCDay() // 0 Sun ... 6 Sat
  const offsetToMonday = day === 0 ? 6 : day - 1
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - offsetToMonday)
  monday.setUTCHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  sunday.setUTCHours(23, 59, 59, 999)
  return {
    weekStartIso: monday.toISOString(),
    weekEndIso: sunday.toISOString(),
    weekStartTs: monday.getTime(),
    weekEndTs: sunday.getTime(),
  }
}

async function loadContactNames(
  service: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return map
  const { data, error } = await service
    .from('contacts')
    .select('id, first_name, last_name, email')
    .eq('user_id', userId)
    .in('id', unique)
  if (error || !data) return map
  for (const c of data as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>) {
    const name =
      [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
      c.email ||
      'Contact'
    map.set(c.id, name)
  }
  return map
}
