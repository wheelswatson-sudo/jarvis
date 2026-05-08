import type { SupabaseClient } from '@supabase/supabase-js'
import type { Contact, Commitment, PersonalDetails } from '../types'
import { contactName } from '../format'
import { enrichBriefingWithIntelligence } from './briefing-intelligence'

// ---------------------------------------------------------------------------
// Daily intelligence briefing assembler.
//
// Pulls overdue commitments, cooling relationships, reciprocity outliers,
// stale-but-valuable contacts, recent social-monitoring updates, and
// (placeholder) connector opportunities, then ranks them as an action list.
// Returns both a structured payload and a rendered markdown view.
// ---------------------------------------------------------------------------

const STALE_DAYS = 30
const SOCIAL_WINDOW_HOURS = 24
const TOP_PER_SECTION = 5
const MIN_RELATIONSHIP_SCORE_FOR_STALE = 0.6
const RECIPROCITY_FLAG_THRESHOLD = 0.3
// New schema-grounded reciprocity_score field on personal_details ranges
// [-1, +1]. Negative means the user is overinvesting in this contact.
const RECIPROCITY_DEBT_THRESHOLD = -0.5

export type BriefingUrgency = 'high' | 'medium' | 'low'

export type BriefingItem = {
  id: string
  category:
    | 'meeting'
    | 'overdue'
    | 'cooling'
    | 'reciprocity'
    | 'stale'
    | 'social'
    | 'connector'
  action: string
  why: string
  contact_id: string | null
  contact_name: string | null
  urgency: BriefingUrgency
  href: string | null
  metadata?: Record<string, unknown>
}

export type BriefingSections = {
  todays_meetings: BriefingItem[]
  overdue_commitments: BriefingItem[]
  cooling_relationships: BriefingItem[]
  reciprocity_flags: BriefingItem[]
  stale_relationships: BriefingItem[]
  social_changes: BriefingItem[]
  connector_opportunities: BriefingItem[]
  // Personalized observations from the LLM enrichment step (AIEA Layer 1).
  // Optional so older cached payloads still parse.
  personalized_observations?: BriefingItem[]
}

export type BriefingPayload = {
  briefing_date: string
  generated_at: string
  user_id: string
  sections: BriefingSections
  ranked_actions: BriefingItem[]
  counts: Record<keyof BriefingSections, number>
  notes: string[]
}

export type BriefingResult = {
  payload: BriefingPayload
  markdown: string
}

type ContactRow = Pick<
  Contact,
  | 'id'
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'tier'
  | 'last_interaction_at'
  | 'relationship_score'
  | 'sentiment_trajectory'
  | 'reciprocity_ratio'
  | 'metrics_computed_at'
  | 'personal_details'
  | 'updated_at'
> & { company?: string | null }

export async function buildDailyBriefing(
  service: SupabaseClient,
  userId: string,
): Promise<BriefingResult> {
  const now = new Date()
  const nowIso = now.toISOString()
  const briefingDate = nowIso.slice(0, 10)

  const staleCutoff = new Date(
    now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const socialCutoff = new Date(
    now.getTime() - SOCIAL_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString()

  const [contactsRes, commitmentsRes] = await Promise.all([
    service
      .from('contacts')
      .select(
        'id, first_name, last_name, email, tier, last_interaction_at, relationship_score, sentiment_trajectory, reciprocity_ratio, metrics_computed_at, personal_details, updated_at, company',
      )
      .eq('user_id', userId)
      .limit(5000),
    service
      .from('commitments')
      .select('id, contact_id, description, due_at, status, owner, created_at')
      .eq('user_id', userId)
      .eq('status', 'open')
      .lt('due_at', nowIso)
      .order('due_at', { ascending: true })
      .limit(50),
  ])

  if (contactsRes.error) throw contactsRes.error
  if (commitmentsRes.error) throw commitmentsRes.error

  const contacts = (contactsRes.data ?? []) as ContactRow[]
  const commitments = (commitmentsRes.data ?? []) as Pick<
    Commitment,
    'id' | 'contact_id' | 'description' | 'due_at' | 'status' | 'owner'
  >[]
  const contactsById = new Map(contacts.map((c) => [c.id, c]))

  const notes: string[] = []

  // --- Today's meetings -------------------------------------------------
  // No calendar integration is wired up yet (login.tsx requests calendar
  // scopes but no sync writes meetings to Supabase). When the integration
  // exists we'll query it here; for now we emit an empty section + a note.
  const meetings = await loadTodaysMeetings(service, userId)
  if (meetings === null) {
    notes.push(
      'Calendar integration not connected — connect Google Calendar in Settings to surface today\'s meetings.',
    )
  }

  // --- Sections ---------------------------------------------------------
  const sections: BriefingSections = {
    todays_meetings: meetings ?? [],
    overdue_commitments: buildOverdueItems(commitments, contactsById),
    cooling_relationships: buildCoolingItems(contacts),
    reciprocity_flags: buildReciprocityItems(contacts),
    stale_relationships: buildStaleItems(contacts, staleCutoff),
    social_changes: buildSocialChangeItems(contacts, socialCutoff),
    connector_opportunities: buildConnectorPlaceholders(contacts),
  }

  const counts: Record<keyof BriefingSections, number> = {
    todays_meetings: sections.todays_meetings.length,
    overdue_commitments: sections.overdue_commitments.length,
    cooling_relationships: sections.cooling_relationships.length,
    reciprocity_flags: sections.reciprocity_flags.length,
    stale_relationships: sections.stale_relationships.length,
    social_changes: sections.social_changes.length,
    connector_opportunities: sections.connector_opportunities.length,
    personalized_observations: 0,
  }

  // Ranked action list — flatten and sort by urgency, then by category
  // priority (high-leverage categories first), then keep one item per
  // contact so a single noisy contact doesn't crowd out the rest of the
  // network. Higher-priority category wins (categoryRank ascending).
  const categoryRank: Record<BriefingItem['category'], number> = {
    meeting: 0,
    overdue: 1,
    cooling: 2,
    social: 3,
    reciprocity: 4,
    stale: 5,
    connector: 6,
  }
  const urgencyRank: Record<BriefingUrgency, number> = {
    high: 0,
    medium: 1,
    low: 2,
  }
  const sortedAll = [
    ...sections.todays_meetings,
    ...sections.overdue_commitments,
    ...sections.cooling_relationships,
    ...sections.social_changes,
    ...sections.reciprocity_flags,
    ...sections.stale_relationships,
    ...sections.connector_opportunities,
  ].sort((a, b) => {
    const u = urgencyRank[a.urgency] - urgencyRank[b.urgency]
    if (u !== 0) return u
    return categoryRank[a.category] - categoryRank[b.category]
  })
  const seenContacts = new Set<string>()
  const ranked_actions: BriefingItem[] = []
  for (const item of sortedAll) {
    if (item.contact_id) {
      if (seenContacts.has(item.contact_id)) continue
      seenContacts.add(item.contact_id)
    }
    ranked_actions.push(item)
  }

  const payload: BriefingPayload = {
    briefing_date: briefingDate,
    generated_at: nowIso,
    user_id: userId,
    sections,
    ranked_actions,
    counts,
    notes,
  }

  // AIEA Layer 1 enrichment: ask the LLM to surface personalized observations
  // grounded in the user_profile + relationship_edges that the daily cron
  // recomputed before this briefing. Best-effort — falls back to the
  // deterministic payload if the API key is missing or the call fails.
  const enriched = await enrichBriefingWithIntelligence(service, userId, payload)

  return { payload: enriched, markdown: renderMarkdown(enriched) }
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

async function loadTodaysMeetings(
  service: SupabaseClient,
  userId: string,
): Promise<BriefingItem[] | null> {
  // Detect a meetings/events table without crashing the briefing if it's
  // not in the schema yet. Try in order: 'calendar_events', 'meetings'.
  // First call to `select('id').limit(0)` will return a 42P01 if the table
  // doesn't exist; we treat any error as "no integration".
  const probe = await service
    .from('calendar_events')
    .select('id')
    .eq('user_id', userId)
    .limit(0)
  if (probe.error) return null

  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)

  const { data, error } = await service
    .from('calendar_events')
    .select('id, title, start_at, end_at, attendees, contact_id')
    .eq('user_id', userId)
    .gte('start_at', start.toISOString())
    .lt('start_at', end.toISOString())
    .order('start_at', { ascending: true })
    .limit(20)
  if (error) return null

  type EventRow = {
    id: string
    title: string | null
    start_at: string
    end_at: string | null
    attendees: unknown
    contact_id: string | null
  }
  return ((data ?? []) as EventRow[]).map((e) => ({
    id: `meeting:${e.id}`,
    category: 'meeting' as const,
    action: e.title ? `Prep for "${e.title}"` : 'Prep for upcoming meeting',
    why: `Starts ${formatTime(e.start_at)} — review context before walking in.`,
    contact_id: e.contact_id ?? null,
    contact_name: null,
    urgency: 'high' as const,
    href: e.contact_id ? `/contacts/${e.contact_id}` : null,
    metadata: { start_at: e.start_at, end_at: e.end_at },
  }))
}

function buildOverdueItems(
  commitments: Pick<
    Commitment,
    'id' | 'contact_id' | 'description' | 'due_at' | 'status' | 'owner'
  >[],
  contactsById: Map<string, ContactRow>,
): BriefingItem[] {
  return commitments.slice(0, TOP_PER_SECTION * 2).map((c) => {
    const contact = c.contact_id ? contactsById.get(c.contact_id) : null
    const overdueBy = c.due_at ? daysBetween(c.due_at, new Date()) : 0
    return {
      id: `overdue:${c.id}`,
      category: 'overdue',
      action: c.description,
      why:
        overdueBy <= 0
          ? 'Due now.'
          : `Overdue by ${Math.round(overdueBy)} day${overdueBy >= 2 ? 's' : ''}.`,
      contact_id: c.contact_id ?? null,
      contact_name: contact ? contactName(contact) : null,
      urgency: 'high',
      href: c.contact_id ? `/contacts/${c.contact_id}` : '/commitments',
      metadata: { due_at: c.due_at, owner: c.owner },
    }
  })
}

function buildCoolingItems(contacts: ContactRow[]): BriefingItem[] {
  const cooling = contacts
    .filter(
      (c) =>
        typeof c.sentiment_trajectory === 'number' &&
        c.sentiment_trajectory < 0,
    )
    .sort(
      (a, b) =>
        (a.sentiment_trajectory ?? 0) - (b.sentiment_trajectory ?? 0),
    )
    .slice(0, TOP_PER_SECTION)

  return cooling.map((c) => {
    const slope = c.sentiment_trajectory ?? 0
    const name = contactName(c)
    return {
      id: `cooling:${c.id}`,
      category: 'cooling',
      action: `Check in with ${name}`,
      why: `Sentiment is trending down (slope ${slope.toFixed(3)}/day). Reset the tone before it hardens.`,
      contact_id: c.id,
      contact_name: name,
      urgency: slope < -0.05 ? 'high' : 'medium',
      href: `/contacts/${c.id}`,
      metadata: { sentiment_trajectory: slope },
    }
  })
}

function buildReciprocityItems(contacts: ContactRow[]): BriefingItem[] {
  const seen = new Set<string>()
  const items: BriefingItem[] = []

  // 1) Schema-grounded reciprocity_score: per-commitment debt signal.
  //    score < -0.5 means the user has done substantially more than the
  //    contact has reciprocated. Strongest reciprocity signal, surface first.
  const debt = contacts
    .filter((c) => {
      const pd = c.personal_details as PersonalDetails | null
      return (
        typeof pd?.reciprocity_score === 'number' &&
        pd.reciprocity_score < RECIPROCITY_DEBT_THRESHOLD
      )
    })
    .sort((a, b) => {
      const sa = (a.personal_details as PersonalDetails | null)?.reciprocity_score ?? 0
      const sb = (b.personal_details as PersonalDetails | null)?.reciprocity_score ?? 0
      return sa - sb
    })
    .slice(0, TOP_PER_SECTION)

  for (const c of debt) {
    const pd = c.personal_details as PersonalDetails | null
    const score = pd?.reciprocity_score ?? 0
    const name = contactName(c)
    const youDid = (pd?.active_commitments_to_them ?? []).filter(
      (x) => x.status === 'completed',
    ).length
    const theyDid = (pd?.active_commitments_from_them ?? []).filter(
      (x) => x.status === 'completed',
    ).length
    items.push({
      id: `reciprocity:${c.id}`,
      category: 'reciprocity',
      action: `Reciprocity debt: ${name}`,
      why: `You've done ${youDid} for them, they've done ${theyDid} for you (score ${score.toFixed(2)}). Stop investing until they reciprocate, or ask for something specific.`,
      contact_id: c.id,
      contact_name: name,
      urgency: 'medium',
      href: `/contacts/${c.id}`,
      metadata: {
        reciprocity_score: score,
        you_did: youDid,
        they_did: theyDid,
        kind: 'commitment_debt',
      },
    })
    seen.add(c.id)
  }

  // 2) Overdue incoming commitments — they promised something, the deadline
  //    passed, you haven't heard back.
  const overdueIncoming = contacts
    .map((c) => {
      const pd = c.personal_details as PersonalDetails | null
      const overdue = (pd?.active_commitments_from_them ?? []).filter(
        (x) =>
          x.status === 'overdue' ||
          (x.status === 'pending' && x.due && new Date(x.due).getTime() < Date.now()),
      )
      return overdue.length > 0 ? { contact: c, overdue } : null
    })
    .filter((x): x is { contact: ContactRow; overdue: NonNullable<PersonalDetails['active_commitments_from_them']> } => x !== null)
    .sort((a, b) => b.overdue.length - a.overdue.length)
    .slice(0, TOP_PER_SECTION)

  for (const { contact, overdue } of overdueIncoming) {
    if (seen.has(contact.id)) continue
    const name = contactName(contact)
    const headline = overdue[0]?.action ?? 'a commitment'
    items.push({
      id: `reciprocity_incoming:${contact.id}`,
      category: 'reciprocity',
      action: `${name} owes you a follow-through`,
      why: `${overdue.length} overdue commitment${overdue.length === 1 ? '' : 's'} from them — most recent: "${truncate(headline, 80)}". A nudge is fair.`,
      contact_id: contact.id,
      contact_name: name,
      urgency: 'medium',
      href: `/contacts/${contact.id}`,
      metadata: {
        overdue_count: overdue.length,
        kind: 'overdue_incoming',
      },
    })
    seen.add(contact.id)
  }

  // 3) Legacy reciprocity_ratio (interaction count fallback) — only surface
  //    contacts not already flagged by the commitment-grounded signals.
  const legacy = contacts
    .filter(
      (c) =>
        !seen.has(c.id) &&
        typeof c.reciprocity_ratio === 'number' &&
        c.reciprocity_ratio < RECIPROCITY_FLAG_THRESHOLD,
    )
    .sort((a, b) => (a.reciprocity_ratio ?? 0) - (b.reciprocity_ratio ?? 0))
    .slice(0, Math.max(0, TOP_PER_SECTION - items.length))

  for (const c of legacy) {
    const ratio = c.reciprocity_ratio ?? 0
    const name = contactName(c)
    items.push({
      id: `reciprocity_ratio:${c.id}`,
      category: 'reciprocity',
      action: `Pause outreach to ${name}`,
      why: `You're sending ${(ratio === 0 ? 0 : 1 / ratio).toFixed(1)}x what you get back. Consider waiting for them to surface, or asking a direct question that requires a reply.`,
      contact_id: c.id,
      contact_name: name,
      urgency: 'medium',
      href: `/contacts/${c.id}`,
      metadata: { reciprocity_ratio: ratio, kind: 'interaction_ratio' },
    })
  }

  return items
}

function buildStaleItems(
  contacts: ContactRow[],
  staleCutoff: string,
): BriefingItem[] {
  const stale = contacts
    .filter(
      (c) =>
        typeof c.relationship_score === 'number' &&
        c.relationship_score >= MIN_RELATIONSHIP_SCORE_FOR_STALE &&
        c.last_interaction_at != null &&
        c.last_interaction_at < staleCutoff,
    )
    .sort(
      (a, b) => (b.relationship_score ?? 0) - (a.relationship_score ?? 0),
    )
    .slice(0, TOP_PER_SECTION)

  return stale.map((c) => {
    const days = c.last_interaction_at
      ? daysBetween(c.last_interaction_at, new Date())
      : null
    const name = contactName(c)
    return {
      id: `stale:${c.id}`,
      category: 'stale',
      action: `Reactivate ${name}`,
      why:
        days != null
          ? `High-value relationship (${Math.round((c.relationship_score ?? 0) * 100)}/100) gone quiet for ${Math.round(days)} days. Dormant asset.`
          : `High-value relationship gone quiet. Dormant asset.`,
      contact_id: c.id,
      contact_name: name,
      urgency: 'medium',
      href: `/contacts/${c.id}`,
      metadata: {
        relationship_score: c.relationship_score,
        days_since: days,
      },
    }
  })
}

function buildSocialChangeItems(
  contacts: ContactRow[],
  socialCutoff: string,
): BriefingItem[] {
  const recent = contacts
    .filter((c) => {
      const pd = c.personal_details as PersonalDetails | null
      const checkedAt = pd?.social_last_checked_at ?? null
      return (
        typeof checkedAt === 'string' &&
        checkedAt >= socialCutoff &&
        c.updated_at >= socialCutoff
      )
    })
    .sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1))
    .slice(0, TOP_PER_SECTION)

  return recent.map((c) => {
    const pd = (c.personal_details as PersonalDetails | null) ?? {}
    const headline =
      pd.linkedin_headline ||
      pd.facebook_workplace ||
      pd.facebook_current_city ||
      'updated profile'
    const name = contactName(c)
    return {
      id: `social:${c.id}`,
      category: 'social',
      action: `${name} has a social update`,
      why: `Recent change spotted: ${truncate(headline, 100)}. Worth a "saw your update" note.`,
      contact_id: c.id,
      contact_name: name,
      urgency: 'medium',
      href: `/contacts/${c.id}`,
      metadata: { headline },
    }
  })
}

function buildConnectorPlaceholders(contacts: ContactRow[]): BriefingItem[] {
  // Lightweight placeholder: pair the highest-scoring stale contact with
  // the highest-scoring fresh contact at the same company. This is a
  // signal-of-a-signal — we'll replace it once interests/needs are
  // structured. Returns at most one suggestion to keep it credible.
  const byCompany = new Map<string, ContactRow[]>()
  for (const c of contacts) {
    const co = (c.company ?? '').trim().toLowerCase()
    if (!co) continue
    const list = byCompany.get(co) ?? []
    list.push(c)
    byCompany.set(co, list)
  }
  for (const list of byCompany.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort(
      (a, b) => (b.relationship_score ?? 0) - (a.relationship_score ?? 0),
    )
    const a = sorted[0]
    const b = sorted[1]
    if (!a || !b || !a.company || a.id === b.id) continue
    const aName = contactName(a)
    const bName = contactName(b)
    return [
      {
        id: `connector:${a.id}:${b.id}`,
        category: 'connector',
        action: `Connect ${aName} ↔ ${bName}`,
        why: `Both at ${a.company}. Possible mutual benefit — confirm before introducing.`,
        contact_id: a.id,
        contact_name: aName,
        urgency: 'low',
        href: `/contacts/${a.id}`,
        metadata: { other_contact_id: b.id, other_contact_name: bName },
      },
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(p: BriefingPayload): string {
  const lines: string[] = []
  lines.push(`# Daily briefing — ${p.briefing_date}`)
  lines.push('')

  const totalActions = p.ranked_actions.length
  if (totalActions === 0) {
    lines.push('Nothing demanding your attention. Use the slack to invest in something compounding.')
    if (p.notes.length > 0) {
      lines.push('')
      for (const n of p.notes) lines.push(`> ${n}`)
    }
    return lines.join('\n')
  }

  lines.push(`**${totalActions} action${totalActions === 1 ? '' : 's'} ranked by urgency.**`)
  lines.push('')

  if (p.sections.personalized_observations && p.sections.personalized_observations.length > 0) {
    appendSection(lines, 'AI observations', p.sections.personalized_observations)
  }
  appendSection(lines, 'Today\'s meetings', p.sections.todays_meetings)
  appendSection(lines, 'Overdue commitments', p.sections.overdue_commitments)
  appendSection(lines, 'Cooling relationships', p.sections.cooling_relationships)
  appendSection(lines, 'Recent social changes', p.sections.social_changes)
  appendSection(lines, 'Reciprocity alert', p.sections.reciprocity_flags)
  appendSection(lines, 'Dormant high-value relationships', p.sections.stale_relationships)
  appendSection(lines, 'Connector opportunities', p.sections.connector_opportunities)

  if (p.notes.length > 0) {
    lines.push('---')
    for (const n of p.notes) lines.push(`> ${n}`)
  }

  return lines.join('\n')
}

function appendSection(
  lines: string[],
  title: string,
  items: BriefingItem[],
): void {
  if (items.length === 0) return
  lines.push(`## ${title}`)
  for (const it of items) {
    const tag = it.urgency === 'high' ? '🔴' : it.urgency === 'medium' ? '🟡' : '🟢'
    lines.push(`- ${tag} **${it.action}** — ${it.why}`)
  }
  lines.push('')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysBetween(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const hh = d.getHours()
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ampm = hh >= 12 ? 'PM' : 'AM'
  const h12 = ((hh + 11) % 12) + 1
  return `${h12}:${mm} ${ampm}`
}

