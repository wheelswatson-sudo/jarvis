// ---------------------------------------------------------------------------
// briefing-intelligence — AIEA Layer 1 LLM enrichment for the daily briefing.
//
// The deterministic briefing in daily-briefing.ts produces the structured
// section list (overdue, cooling, stale, etc.). This module sits on top:
// it pulls the user_profile + relationship_edges that the daily cron just
// recomputed, builds a rich system prompt, and asks the LLM to surface
// 3-7 personalized observations the deterministic rules can't see —
// reciprocity drift, meeting load against tolerance, aging commitments,
// trend changes against the user's typical patterns.
//
// Returns null on any failure (no API key, parse error, rate limit) so the
// caller can fall back to the deterministic payload alone. Never throws.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BriefingPayload,
  BriefingItem,
  BriefingUrgency,
} from './daily-briefing'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

const TOP_EDGES_FOR_PROMPT = 25
const COOLING_DORMANT_LIMIT = 10
const RECIPROCITY_OUTLIER_LIMIT = 8
const AGING_COMMITMENT_DAYS = 7
const AGING_COMMITMENT_LIMIT = 10
const MIN_RECIPROCITY_OUTLIER_INTERACTIONS = 5
const RECIPROCITY_LOW = 0.2
const RECIPROCITY_HIGH = 0.8

export type PersonalizedObservation = {
  category: 'pattern' | 'relationship' | 'load' | 'commitment'
  action: string
  why: string
  contact_id: string | null
  contact_name: string | null
  urgency: BriefingUrgency
}

export type IntelligenceContext = {
  profile: {
    avg_response_time_minutes: number | null
    active_hours_start: number | null
    active_hours_end: number | null
    meeting_tolerance_daily: number | null
    formality_score: number | null
    avg_outbound_length_chars: number | null
    top_contacts: { contact_id: string; score: number }[]
  } | null
  cooling: { contact_id: string; trend: string; strength: number }[]
  reciprocity_outliers: {
    contact_id: string
    initiated_by_me_pct: number | null
    interactions_30d: number
  }[]
  aging_commitments: {
    id: string
    description: string
    age_days: number
    contact_id: string | null
  }[]
  meetings_today: number
}

// Enrich the deterministic payload with LLM-generated observations.
// Returns the (possibly mutated) payload. Best-effort — never throws.
export async function enrichBriefingWithIntelligence(
  service: SupabaseClient,
  userId: string,
  payload: BriefingPayload,
): Promise<BriefingPayload> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return payload

  let context: IntelligenceContext
  try {
    context = await loadIntelligenceContext(service, userId, payload)
  } catch (err) {
    console.warn(
      '[briefing-intelligence] context load failed:',
      err instanceof Error ? err.message : String(err),
    )
    return payload
  }

  // If we have nothing learned yet (cold start), skip the LLM call.
  if (
    !context.profile &&
    context.cooling.length === 0 &&
    context.reciprocity_outliers.length === 0 &&
    context.aging_commitments.length === 0
  ) {
    return payload
  }

  let observations: PersonalizedObservation[] = []
  try {
    observations = await callLlm(apiKey, payload, context)
  } catch (err) {
    console.warn(
      '[briefing-intelligence] LLM call failed:',
      err instanceof Error ? err.message : String(err),
    )
    return payload
  }

  if (observations.length === 0) return payload

  const contactNames = await loadContactNames(
    service,
    userId,
    observations
      .map((o) => o.contact_id)
      .filter((x): x is string => typeof x === 'string'),
  )

  const items: BriefingItem[] = observations.map((o, idx) => ({
    id: `personalized:${idx}`,
    category: mapCategory(o.category),
    action: o.action,
    why: o.why,
    contact_id: o.contact_id,
    contact_name:
      o.contact_id != null
        ? (contactNames.get(o.contact_id) ?? o.contact_name)
        : o.contact_name,
    urgency: o.urgency,
    href: o.contact_id != null ? `/contacts/${o.contact_id}` : null,
    metadata: { source: 'intelligence', original_category: o.category },
  }))

  // Mutate sections + counts + ranked_actions + add a `personalized` key.
  const next: BriefingPayload & {
    sections: BriefingPayload['sections'] & {
      personalized_observations?: BriefingItem[]
    }
    counts: BriefingPayload['counts'] & {
      personalized_observations?: number
    }
  } = {
    ...payload,
    sections: { ...payload.sections, personalized_observations: items },
    counts: {
      ...payload.counts,
      personalized_observations: items.length,
    } as BriefingPayload['counts'] & { personalized_observations: number },
    ranked_actions: rerank([...items, ...payload.ranked_actions]),
  }
  return next
}

// ---------------------------------------------------------------------------
// Context loader
// ---------------------------------------------------------------------------

async function loadIntelligenceContext(
  service: SupabaseClient,
  userId: string,
  payload: BriefingPayload,
): Promise<IntelligenceContext> {
  const [profileRes, edgesRes, commitmentsRes] = await Promise.all([
    service
      .from('user_profiles')
      .select(
        'avg_response_time_minutes, active_hours_start, active_hours_end, meeting_tolerance_daily, top_contacts, communication_style',
      )
      .eq('user_id', userId)
      .maybeSingle(),
    service
      .from('relationship_edges')
      .select(
        'contact_id, strength, trend, interaction_count_30d, interaction_count_90d, reciprocity_score, initiated_by_me_pct, last_interaction_at',
      )
      .eq('user_id', userId)
      .order('strength', { ascending: false })
      .limit(500),
    service
      .from('commitments')
      .select('id, description, owner, contact_id, created_at, status, due_at')
      .eq('user_id', userId)
      .eq('status', 'open')
      .lt(
        'created_at',
        new Date(
          Date.now() - AGING_COMMITMENT_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString(),
      )
      .order('created_at', { ascending: true })
      .limit(50),
  ])

  type ProfileRow = {
    avg_response_time_minutes: number | null
    active_hours_start: number | null
    active_hours_end: number | null
    meeting_tolerance_daily: number | null
    top_contacts: unknown
    communication_style: unknown
  }
  type EdgeRow = {
    contact_id: string
    strength: number
    trend: string
    interaction_count_30d: number
    interaction_count_90d: number
    reciprocity_score: number | null
    initiated_by_me_pct: number | null
    last_interaction_at: string | null
  }
  type CommitmentRow = {
    id: string
    description: string
    owner: string
    contact_id: string | null
    created_at: string
    status: string
    due_at: string | null
  }

  const profileRow = (profileRes.data ?? null) as ProfileRow | null
  const edges = (edgesRes.data ?? []) as EdgeRow[]
  const aging = (commitmentsRes.data ?? []) as CommitmentRow[]

  const cooling = edges
    .filter((e) => e.trend === 'cooling' || e.trend === 'dormant')
    .slice(0, COOLING_DORMANT_LIMIT)
    .map((e) => ({
      contact_id: e.contact_id,
      trend: e.trend,
      strength: e.strength,
    }))

  const reciprocity_outliers = edges
    .filter(
      (e) =>
        e.interaction_count_30d >= MIN_RECIPROCITY_OUTLIER_INTERACTIONS &&
        e.initiated_by_me_pct != null &&
        (e.initiated_by_me_pct <= RECIPROCITY_LOW ||
          e.initiated_by_me_pct >= RECIPROCITY_HIGH),
    )
    .slice(0, RECIPROCITY_OUTLIER_LIMIT)
    .map((e) => ({
      contact_id: e.contact_id,
      initiated_by_me_pct: e.initiated_by_me_pct,
      interactions_30d: e.interaction_count_30d,
    }))

  const profile = profileRow
    ? {
        avg_response_time_minutes: profileRow.avg_response_time_minutes,
        active_hours_start: profileRow.active_hours_start,
        active_hours_end: profileRow.active_hours_end,
        meeting_tolerance_daily: profileRow.meeting_tolerance_daily,
        formality_score: extractFormality(profileRow.communication_style),
        avg_outbound_length_chars: extractAvgLength(
          profileRow.communication_style,
        ),
        top_contacts: parseTopContacts(profileRow.top_contacts),
      }
    : null

  const now = Date.now()
  const aging_commitments = aging
    .slice(0, AGING_COMMITMENT_LIMIT)
    .map((c) => ({
      id: c.id,
      description: c.description,
      contact_id: c.contact_id,
      age_days: Math.floor(
        (now - new Date(c.created_at).getTime()) / (24 * 60 * 60 * 1000),
      ),
    }))

  return {
    profile,
    cooling,
    reciprocity_outliers,
    aging_commitments,
    meetings_today: payload.sections.todays_meetings.length,
  }
}

function extractFormality(raw: unknown): number | null {
  if (raw && typeof raw === 'object' && 'formality_score' in raw) {
    const v = (raw as { formality_score: unknown }).formality_score
    return typeof v === 'number' ? v : null
  }
  return null
}

function extractAvgLength(raw: unknown): number | null {
  if (raw && typeof raw === 'object' && 'avg_outbound_length_chars' in raw) {
    const v = (raw as { avg_outbound_length_chars: unknown })
      .avg_outbound_length_chars
    return typeof v === 'number' ? v : null
  }
  return null
}

function parseTopContacts(
  raw: unknown,
): { contact_id: string; score: number }[] {
  if (!Array.isArray(raw)) return []
  const out: { contact_id: string; score: number }[] = []
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { contact_id?: unknown }).contact_id === 'string'
    ) {
      const score = (item as { score?: unknown }).score
      out.push({
        contact_id: (item as { contact_id: string }).contact_id,
        score: typeof score === 'number' ? score : 0,
      })
    }
  }
  return out.slice(0, TOP_EDGES_FOR_PROMPT)
}

async function loadContactNames(
  service: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const unique = Array.from(new Set(ids))
  const { data } = await service
    .from('contacts')
    .select('id, first_name, last_name, email')
    .eq('user_id', userId)
    .in('id', unique)
  type ContactRow = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }
  for (const c of (data ?? []) as ContactRow[]) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
    out.set(c.id, name || c.email || '(unknown contact)')
  }
  return out
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm(
  apiKey: string,
  payload: BriefingPayload,
  context: IntelligenceContext,
): Promise<PersonalizedObservation[]> {
  const profileBlock = context.profile
    ? [
        `- Avg email response: ${context.profile.avg_response_time_minutes ?? '?'} min`,
        `- Typically active: ${formatHour(context.profile.active_hours_start)}–${formatHour(context.profile.active_hours_end)}`,
        `- Meeting tolerance: ~${context.profile.meeting_tolerance_daily ?? '?'} meetings/day`,
        `- Communication style: ${formatFormality(context.profile.formality_score)}, avg outbound ${context.profile.avg_outbound_length_chars ?? '?'} chars`,
        `- Top ${context.profile.top_contacts.length} contacts (by frequency, score 0–1): ${context.profile.top_contacts
          .slice(0, 25)
          .map((t) => `${t.contact_id.slice(0, 8)}=${t.score.toFixed(2)}`)
          .join(', ') || '(none)'}`,
      ].join('\n')
    : '(no profile yet — cold start)'

  const coolingBlock =
    context.cooling.length === 0
      ? '(none)'
      : context.cooling
          .map(
            (c) =>
              `- ${c.contact_id.slice(0, 8)} trend=${c.trend} strength=${c.strength.toFixed(2)}`,
          )
          .join('\n')

  const reciprocityBlock =
    context.reciprocity_outliers.length === 0
      ? '(none)'
      : context.reciprocity_outliers
          .map(
            (r) =>
              `- ${r.contact_id.slice(0, 8)} initiated_by_me=${(r.initiated_by_me_pct! * 100).toFixed(0)}% over ${r.interactions_30d} interactions/30d`,
          )
          .join('\n')

  const agingBlock =
    context.aging_commitments.length === 0
      ? '(none)'
      : context.aging_commitments
          .map(
            (c) =>
              `- "${truncate(c.description, 80)}" — ${c.age_days}d old${c.contact_id ? ` · contact=${c.contact_id.slice(0, 8)}` : ''}`,
          )
          .join('\n')

  const tolerance = context.profile?.meeting_tolerance_daily ?? null
  const meetingsToday = context.meetings_today
  const meetingNote =
    tolerance != null
      ? `Today: ${meetingsToday} meetings. Typical tolerance: ~${tolerance}/day.`
      : `Today: ${meetingsToday} meetings.`

  const system = `You are a senior executive assistant analyzing one day's briefing for the executive. Your job is to surface 3 to 7 personalized observations that the rule-based sections of the briefing miss.

Each observation must be:
- Concrete and grounded in the data below (cite the contact_id when relevant)
- Specific to the executive's profile (their cadence, their tolerance, their top contacts)
- Actionable in 1–2 sentences
- Avoid restating items already in the deterministic sections

Output strict JSON: { "observations": [ { "category": "pattern" | "relationship" | "load" | "commitment", "action": string (imperative), "why": string (one sentence), "contact_id": string | null, "contact_name": string | null, "urgency": "high" | "medium" | "low" } ] }

If there is nothing useful to add, return { "observations": [] }. Never invent data not present below. Never quote raw IDs in the action/why prose — use the contact_id field instead.`

  const user = `Executive profile:
${profileBlock}

Today's load:
${meetingNote}

Cooling / dormant relationships (drop in cadence vs prior 90d):
${coolingBlock}

Reciprocity outliers (one-sided thread initiation, ≥${MIN_RECIPROCITY_OUTLIER_INTERACTIONS} interactions in 30d):
${reciprocityBlock}

Commitments aging beyond ${AGING_COMMITMENT_DAYS} days with no resolution:
${agingBlock}

Deterministic sections already include: ${Object.entries(payload.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(', ') || '(none)'}.

Return JSON only.`

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })

  if (!res.ok) {
    throw new Error(
      `Groq error ${res.status}: ${(await res.text()).slice(0, 200)}`,
    )
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) return []

  type ParsedShape = {
    observations?: unknown
  }
  let parsed: ParsedShape
  try {
    parsed = JSON.parse(content) as ParsedShape
  } catch {
    return []
  }

  if (!Array.isArray(parsed.observations)) return []

  const out: PersonalizedObservation[] = []
  for (const o of parsed.observations) {
    if (!o || typeof o !== 'object') continue
    const obj = o as Record<string, unknown>
    const action = typeof obj.action === 'string' ? obj.action.trim() : ''
    const why = typeof obj.why === 'string' ? obj.why.trim() : ''
    if (!action || !why) continue
    const category = sanitizeCategory(obj.category)
    const urgency = sanitizeUrgency(obj.urgency)
    out.push({
      category,
      action,
      why,
      contact_id: typeof obj.contact_id === 'string' ? obj.contact_id : null,
      contact_name:
        typeof obj.contact_name === 'string' ? obj.contact_name : null,
      urgency,
    })
    if (out.length >= 8) break
  }
  return out
}

function sanitizeCategory(
  raw: unknown,
): PersonalizedObservation['category'] {
  if (
    raw === 'pattern' ||
    raw === 'relationship' ||
    raw === 'load' ||
    raw === 'commitment'
  )
    return raw
  return 'pattern'
}

function sanitizeUrgency(raw: unknown): BriefingUrgency {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw
  return 'medium'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapCategory(
  c: PersonalizedObservation['category'],
): BriefingItem['category'] {
  switch (c) {
    case 'relationship':
      return 'cooling'
    case 'commitment':
      return 'overdue'
    case 'load':
      return 'meeting'
    default:
      return 'connector'
  }
}

function rerank(items: BriefingItem[]): BriefingItem[] {
  const urgencyRank: Record<BriefingUrgency, number> = {
    high: 0,
    medium: 1,
    low: 2,
  }
  return [...items].sort((a, b) => {
    const u = urgencyRank[a.urgency] - urgencyRank[b.urgency]
    if (u !== 0) return u
    // Personalized observations bubble up within the same urgency tier.
    const aPersonal =
      a.metadata && (a.metadata as { source?: string }).source === 'intelligence'
        ? 0
        : 1
    const bPersonal =
      b.metadata && (b.metadata as { source?: string }).source === 'intelligence'
        ? 0
        : 1
    return aPersonal - bPersonal
  })
}

function formatHour(h: number | null): string {
  if (h == null) return '?'
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = ((h + 11) % 12) + 1
  return `${h12}${ampm}`
}

function formatFormality(score: number | null): string {
  if (score == null) return 'unknown'
  if (score >= 0.7) return 'formal'
  if (score >= 0.4) return 'mixed'
  return 'casual'
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
