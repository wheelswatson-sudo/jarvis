// ---------------------------------------------------------------------------
// findForgottenLoops — the "what fell through the cracks?" surface.
//
// Three patterns a great EA catches that the user has missed:
//
//   1. UNREPLIED_INBOUND — they wrote you, you never replied, the thread is
//      cold. Surfaces "Sarah asked about pricing 12 days ago, no reply yet."
//   2. SILENT_OVERDUE_COMMITMENT — you owe them something (open commitment,
//      owner=me), it's past due, AND there's been no outbound contact since
//      the commitment was made. Surfaces "You promised the deck to Mark 18d
//      ago — overdue, and you haven't touched the thread."
//   3. STALLED_OUTBOUND — you wrote them, they ghosted, and it's been long
//      enough that they've probably forgotten too. Surfaces "Followed up
//      with Jamie 14d ago, no response — nudge again or let it die."
//
// Severity blends days-elapsed with relationship_score so a forgotten loop
// with a top-tier contact bubbles above noise. Items capped at MAX_ITEMS;
// callers render top-N.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'

const UNREPLIED_INBOUND_DAYS = 5
const STALLED_OUTBOUND_DAYS = 7
const OVERDUE_COMMITMENT_DAYS = 5
const SILENT_THREAD_LOOKBACK_DAYS = 90
const MAX_ITEMS = 12
// Skip noise from contacts the user has effectively no relationship with.
// `null` (never computed) is allowed through — first-time users have no
// scores yet but real loops still matter.
const MIN_RELATIONSHIP_SCORE = 0.15

export type ForgottenLoopType =
  | 'unreplied_inbound'
  | 'stalled_outbound'
  | 'silent_overdue_commitment'

export type ForgottenLoop = {
  id: string
  type: ForgottenLoopType
  contact_id: string
  contact_name: string
  // The anchor message_id, when the loop is anchored to a message (unreplied
  // or stalled). NULL for silent_overdue_commitment — those tie back to a
  // commitment row, not a message.
  message_id: string | null
  days: number
  severity: 'critical' | 'high' | 'medium'
  hint: string
  snippet: string | null
  cta: string
  href: string
  relationship_score: number | null
}

type MessageRow = {
  id: string
  contact_id: string | null
  direction: 'inbound' | 'outbound' | null
  subject: string | null
  snippet: string | null
  sent_at: string
  external_url: string | null
}

type ContactRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  relationship_score: number | null
  tier: number | null
}

type CommitmentRow = {
  id: string
  contact_id: string | null
  description: string
  owner: 'me' | 'them' | null
  status: string
  due_at: string | null
  created_at: string
}

export async function findForgottenLoops(
  service: SupabaseClient,
  userId: string,
): Promise<ForgottenLoop[]> {
  const now = Date.now()
  const lookbackIso = new Date(
    now - SILENT_THREAD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const [contactsRes, messagesRes, commitmentsRes] = await Promise.all([
    service
      .from('contacts')
      .select('id, first_name, last_name, email, relationship_score, tier')
      .eq('user_id', userId)
      .limit(5000),
    service
      .from('messages')
      .select(
        'id, contact_id, direction, subject, snippet, sent_at, external_url',
      )
      .eq('user_id', userId)
      .not('contact_id', 'is', null)
      .gte('sent_at', lookbackIso)
      .order('sent_at', { ascending: false })
      .limit(20000),
    service
      .from('commitments')
      .select('id, contact_id, description, owner, status, due_at, created_at')
      .eq('user_id', userId)
      .eq('status', 'open')
      .not('contact_id', 'is', null)
      .limit(5000),
  ])

  const contacts = (contactsRes.data ?? []) as ContactRow[]
  const messages = (messagesRes.data ?? []) as MessageRow[]
  const commitments = (commitmentsRes.data ?? []) as CommitmentRow[]

  const contactsById = new Map<string, ContactRow>()
  for (const c of contacts) contactsById.set(c.id, c)

  // Group messages by contact, retaining order (most-recent first since we
  // sorted descending). For each contact, the first message in the list is
  // the most recent.
  const messagesByContact = new Map<string, MessageRow[]>()
  for (const m of messages) {
    if (!m.contact_id) continue
    const list = messagesByContact.get(m.contact_id)
    if (list) list.push(m)
    else messagesByContact.set(m.contact_id, [m])
  }

  const loops: ForgottenLoop[] = []

  // ---- Pattern 1 + 3: thread-state from message order ---------------------
  for (const [contactId, msgs] of messagesByContact) {
    const contact = contactsById.get(contactId)
    if (!contact) continue
    if (!passesScoreFloor(contact)) continue

    const latest = msgs[0]
    if (!latest) continue
    const ageDays = daysSince(latest.sent_at, now)

    if (latest.direction === 'inbound' && ageDays >= UNREPLIED_INBOUND_DAYS) {
      // Make sure there's no outbound newer than the latest inbound.
      // (`msgs` is sorted desc; if the first one is inbound, by definition
      // no later outbound exists. Invariant holds — just be defensive.)
      const hasNewerOutbound = msgs.some(
        (m) =>
          m.direction === 'outbound' &&
          new Date(m.sent_at).getTime() > new Date(latest.sent_at).getTime(),
      )
      if (hasNewerOutbound) continue

      const name = nameOf(contact)
      loops.push({
        id: `unreplied:${latest.id}`,
        type: 'unreplied_inbound',
        contact_id: contactId,
        contact_name: name,
        message_id: latest.id,
        days: ageDays,
        severity: severityFromAgeAndScore(ageDays, contact.relationship_score),
        hint: `${name} wrote ${ageDays}d ago — no reply yet.`,
        snippet: latest.subject ?? latest.snippet,
        cta: 'Reply',
        href: `/contacts/${contactId}`,
        relationship_score: contact.relationship_score,
      })
      continue
    }

    if (
      latest.direction === 'outbound' &&
      ageDays >= STALLED_OUTBOUND_DAYS &&
      // Heuristic: at least one earlier inbound in the lookback window.
      // Filters out cold one-shots the user blasted (those aren't loops,
      // they're outreach).
      msgs.some((m) => m.direction === 'inbound')
    ) {
      const name = nameOf(contact)
      loops.push({
        id: `stalled:${latest.id}`,
        type: 'stalled_outbound',
        contact_id: contactId,
        contact_name: name,
        message_id: latest.id,
        days: ageDays,
        severity: severityFromAgeAndScore(ageDays, contact.relationship_score),
        hint: `You wrote ${name} ${ageDays}d ago — no response.`,
        snippet: latest.subject ?? latest.snippet,
        cta: 'Nudge or close',
        href: `/contacts/${contactId}`,
        relationship_score: contact.relationship_score,
      })
    }
  }

  // ---- Pattern 2: silent overdue commitments ------------------------------
  for (const c of commitments) {
    if (!c.contact_id) continue
    if (c.owner !== 'me') continue
    const contact = contactsById.get(c.contact_id)
    if (!contact) continue
    if (!passesScoreFloor(contact)) continue

    const overdueDays = c.due_at ? daysSince(c.due_at, now) : null
    if (overdueDays == null || overdueDays < OVERDUE_COMMITMENT_DAYS) continue

    // "Silent" = no outbound message to this contact since the commitment
    // was created. If we sent something newer, it's just overdue, not
    // forgotten.
    const contactMsgs = messagesByContact.get(c.contact_id) ?? []
    const commitmentTs = new Date(c.created_at).getTime()
    const sentSince = contactMsgs.some(
      (m) =>
        m.direction === 'outbound' &&
        new Date(m.sent_at).getTime() > commitmentTs,
    )
    if (sentSince) continue

    const name = nameOf(contact)
    loops.push({
      id: `silent-com:${c.id}`,
      type: 'silent_overdue_commitment',
      contact_id: c.contact_id,
      contact_name: name,
      message_id: null,
      days: overdueDays,
      // Silent overdue commitments to high-value contacts are critical —
      // these are reputation hits in slow motion.
      severity: severityFromAgeAndScore(overdueDays, contact.relationship_score, 1.5),
      hint: `You owed ${name} "${truncate(c.description, 60)}" — ${overdueDays}d overdue, no follow-up.`,
      snippet: c.description,
      cta: 'Send it',
      href: `/contacts/${c.contact_id}`,
      relationship_score: contact.relationship_score,
    })
  }

  // Dedupe by contact: a contact can have at most one loop in the list
  // (highest-severity wins). Otherwise a single quiet relationship can fill
  // half the surface.
  const bestByContact = new Map<string, ForgottenLoop>()
  for (const loop of loops) {
    const existing = bestByContact.get(loop.contact_id)
    if (!existing || severityRank(loop) > severityRank(existing)) {
      bestByContact.set(loop.contact_id, loop)
    }
  }

  return Array.from(bestByContact.values())
    .sort((a, b) => severityRank(b) - severityRank(a))
    .slice(0, MAX_ITEMS)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function passesScoreFloor(contact: ContactRow): boolean {
  // Tier 1/2 always passes — the score may not have computed yet.
  if (contact.tier === 1 || contact.tier === 2) return true
  if (contact.relationship_score == null) return true
  return contact.relationship_score >= MIN_RELATIONSHIP_SCORE
}

function severityFromAgeAndScore(
  days: number,
  score: number | null,
  multiplier = 1,
): 'critical' | 'high' | 'medium' {
  // Critical: high-value AND > 14d, or > 30d regardless.
  // High: > 10d on a known-value contact, or > 14d otherwise.
  // Medium: everything else above threshold.
  const s = score ?? 0
  const heat = days * multiplier + s * 30
  if (heat >= 30) return 'critical'
  if (heat >= 18) return 'high'
  return 'medium'
}

function severityRank(loop: ForgottenLoop): number {
  const sev = loop.severity === 'critical' ? 100 : loop.severity === 'high' ? 50 : 0
  // Tiebreak by score, then by days. Commitments outrank threads at the
  // same severity because they're explicit promises.
  const typeBonus = loop.type === 'silent_overdue_commitment' ? 5 : 0
  return sev + typeBonus + loop.days + (loop.relationship_score ?? 0) * 30
}

function daysSince(iso: string, now: number): number {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((now - t) / (24 * 60 * 60 * 1000)))
}

function nameOf(c: ContactRow): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.join(' ').trim()
  return c.email ?? 'Unknown contact'
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}
