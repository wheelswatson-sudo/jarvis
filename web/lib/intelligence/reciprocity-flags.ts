// ---------------------------------------------------------------------------
// findReciprocityFlags — "you've done more for them than they've done for you."
//
// Reads contacts' personal_details.reciprocity_score (signed -1 to +1; <0
// means the user is overinvesting). The daily-briefing lib already computes
// this for the morning memo, but it never made it onto /home as its own
// surface — this is the dedicated lane.
//
// The EA framing is NOT "they're a bad friend." It's "this relationship
// has structural debt; either stop unilaterally investing or make a
// specific ask so they can reciprocate cleanly."
//
// Pure read of existing data — no migration.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PersonalDetails } from '../types'

// Tunables. `reciprocity_score` is signed [-1, +1]; -1 = user did
// everything, 0 = balanced, +1 = contact did everything. Threshold -0.5
// matches the daily-briefing definition.
const DEBT_THRESHOLD = -0.5
const MAX_ITEMS = 6
const MIN_RELATIONSHIP_SCORE = 0.2

export type ReciprocityFlag = {
  id: string
  contact_id: string
  contact_name: string
  reciprocity_score: number
  you_did: number
  they_did: number
  severity: 'critical' | 'high' | 'medium'
  hint: string
  href: string
  relationship_score: number | null
}

type ContactRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  tier: number | null
  relationship_score: number | null
  personal_details: PersonalDetails | null
}

export async function findReciprocityFlags(
  service: SupabaseClient,
  userId: string,
): Promise<ReciprocityFlag[]> {
  const { data, error } = await service
    .from('contacts')
    .select(
      'id, first_name, last_name, email, tier, relationship_score, personal_details',
    )
    .eq('user_id', userId)
    .limit(5000)

  if (error) return []
  const contacts = (data ?? []) as ContactRow[]

  const items: ReciprocityFlag[] = []
  for (const c of contacts) {
    const pd = c.personal_details
    if (!pd) continue
    const score = pd.reciprocity_score
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    if (score >= DEBT_THRESHOLD) continue
    if (!passesFloor(c)) continue

    const youDid = (pd.active_commitments_to_them ?? []).filter(
      (x) => x.status === 'completed',
    ).length
    const theyDid = (pd.active_commitments_from_them ?? []).filter(
      (x) => x.status === 'completed',
    ).length

    const name = nameOf(c)
    items.push({
      id: `reciprocity:${c.id}`,
      contact_id: c.id,
      contact_name: name,
      reciprocity_score: score,
      you_did: youDid,
      they_did: theyDid,
      severity: severityFromScore(score),
      hint: buildHint(name, score, youDid, theyDid),
      href: `/contacts/${c.id}`,
      relationship_score: c.relationship_score,
    })
  }

  return items
    .sort((a, b) => a.reciprocity_score - b.reciprocity_score) // most-debted first
    .slice(0, MAX_ITEMS)
}

function passesFloor(c: ContactRow): boolean {
  if (c.tier === 1 || c.tier === 2) return true
  if (c.relationship_score == null) return true
  return c.relationship_score >= MIN_RELATIONSHIP_SCORE
}

function severityFromScore(score: number): 'critical' | 'high' | 'medium' {
  // -1 = total imbalance; -0.5 = our threshold. Scale severity inside that band.
  if (score <= -0.8) return 'critical'
  if (score <= -0.65) return 'high'
  return 'medium'
}

function buildHint(
  name: string,
  score: number,
  youDid: number,
  theyDid: number,
): string {
  // Lead with the relationship framing, not the math. Numbers come second
  // for sanity-check.
  const balance = youDid > 0 && theyDid > 0 ? `${youDid}:${theyDid}` : null
  const detail = balance
    ? `you've delivered ${youDid}, they've delivered ${theyDid}.`
    : `imbalance score ${score.toFixed(2)}.`
  return `${name} — you're overinvesting; ${detail}`
}

function nameOf(c: ContactRow): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.join(' ').trim()
  return c.email ?? 'Unknown contact'
}
