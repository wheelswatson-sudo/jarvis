// ---------------------------------------------------------------------------
// findOwedToYou — the mirror of forgotten-loops: things THEY owe YOU.
//
// Pulls open commitments with owner='them' that are past due (or due very
// soon, depending on caller). Most useful for sales pipelines and external
// requests — "you said you'd send the contract last week."
//
// Forgotten-loops covers `silent_overdue_commitment` for owner='me' (your
// reputation hits in slow motion). This covers the inverse — when someone
// else has stalled, the EA move is a gentle nudge, not radio silence.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'

const OVERDUE_GRACE_DAYS = 2 // give them a 2-day cushion before flagging
const DUE_SOON_DAYS = 3
const MAX_ITEMS = 8
const MIN_RELATIONSHIP_SCORE = 0.2 // skip noise from wider-network contacts

export type OwedToYou = {
  id: string
  contact_id: string
  contact_name: string
  description: string
  due_at: string | null
  // Negative = overdue (in days); 0 = today; positive = due in N days.
  days_relative: number
  severity: 'critical' | 'high' | 'medium'
  hint: string
  href: string
  relationship_score: number | null
}

type CommitmentRow = {
  id: string
  contact_id: string | null
  description: string
  owner: 'me' | 'them' | null
  status: string
  due_at: string | null
}

type ContactRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  relationship_score: number | null
  tier: number | null
}

export async function findOwedToYou(
  service: SupabaseClient,
  userId: string,
): Promise<OwedToYou[]> {
  const now = Date.now()

  const [comRes, contactsRes] = await Promise.all([
    service
      .from('commitments')
      .select('id, contact_id, description, owner, status, due_at')
      .eq('user_id', userId)
      .eq('owner', 'them')
      .eq('status', 'open')
      .not('contact_id', 'is', null)
      .not('due_at', 'is', null)
      .limit(2000),
    service
      .from('contacts')
      .select('id, first_name, last_name, email, relationship_score, tier')
      .eq('user_id', userId)
      .limit(5000),
  ])

  const commitments = (comRes.data ?? []) as CommitmentRow[]
  const contacts = (contactsRes.data ?? []) as ContactRow[]
  const contactsById = new Map<string, ContactRow>()
  for (const c of contacts) contactsById.set(c.id, c)

  const items: OwedToYou[] = []
  for (const c of commitments) {
    if (!c.contact_id || !c.due_at) continue
    const contact = contactsById.get(c.contact_id)
    if (!contact) continue
    if (!passesScoreFloor(contact)) continue

    const dueTs = new Date(c.due_at).getTime()
    if (!Number.isFinite(dueTs)) continue
    const daysRelative = Math.floor((dueTs - now) / (24 * 60 * 60 * 1000))
    // Only flag if overdue past grace OR due within DUE_SOON_DAYS.
    if (daysRelative < -OVERDUE_GRACE_DAYS) {
      // overdue — keep
    } else if (daysRelative >= -OVERDUE_GRACE_DAYS && daysRelative <= DUE_SOON_DAYS) {
      // due soon — keep
    } else {
      continue
    }

    const name = nameOf(contact)
    items.push({
      id: `owed:${c.id}`,
      contact_id: c.contact_id,
      contact_name: name,
      description: c.description,
      due_at: c.due_at,
      days_relative: daysRelative,
      severity: severityFromDelay(daysRelative, contact.relationship_score),
      hint: buildHint(name, c.description, daysRelative),
      href: `/contacts/${c.contact_id}`,
      relationship_score: contact.relationship_score,
    })
  }

  return items
    .sort((a, b) => severityRank(b) - severityRank(a))
    .slice(0, MAX_ITEMS)
}

function passesScoreFloor(contact: ContactRow): boolean {
  if (contact.tier === 1 || contact.tier === 2) return true
  if (contact.relationship_score == null) return true
  return contact.relationship_score >= MIN_RELATIONSHIP_SCORE
}

function severityFromDelay(
  daysRelative: number,
  score: number | null,
): 'critical' | 'high' | 'medium' {
  const overdue = -daysRelative
  if (overdue >= 14) return 'critical'
  if (overdue >= 5) return 'high'
  if (overdue >= 0) return 'medium'
  // Due-soon items default to medium; high-value contacts bump to high.
  return (score ?? 0) >= 0.6 ? 'high' : 'medium'
}

function severityRank(item: OwedToYou): number {
  const sev = item.severity === 'critical' ? 100 : item.severity === 'high' ? 50 : 0
  // Older overdue ranks higher than fresh overdue at the same severity.
  return sev + Math.max(0, -item.days_relative) + (item.relationship_score ?? 0) * 20
}

function buildHint(name: string, description: string, daysRelative: number): string {
  if (daysRelative < 0) {
    const overdue = -daysRelative
    return `${name} owes you "${truncate(description, 60)}" — ${overdue}d overdue.`
  }
  if (daysRelative === 0) {
    return `${name} owes you "${truncate(description, 60)}" — due today.`
  }
  if (daysRelative === 1) {
    return `${name} owes you "${truncate(description, 60)}" — due tomorrow.`
  }
  return `${name} owes you "${truncate(description, 60)}" — due in ${daysRelative}d.`
}

function nameOf(c: ContactRow): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.join(' ').trim()
  return c.email ?? 'Unknown contact'
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}
