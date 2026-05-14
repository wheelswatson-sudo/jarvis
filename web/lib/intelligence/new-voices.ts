// ---------------------------------------------------------------------------
// findNewVoices — inbound messages from "new" or "re-emerging" contacts.
//
// Two patterns worth catching separately from the daily action list:
//
//   1. BRAND_NEW — first inbound from this contact in the last 14d, AND
//      no prior inbound from them ever (in our window). Easy to miss in
//      a busy inbox.
//   2. REEMERGING — inbound in the last 14d, but the prior inbound from
//      them was 90+ days ago. They're back; pay attention.
//
// The EA move on both is the same: a thoughtful, fast acknowledgment so
// they know you noticed.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'

const RECENT_WINDOW_DAYS = 14
const REEMERGE_GAP_DAYS = 90
const HISTORY_LOOKBACK_DAYS = 365
const MAX_ITEMS = 6
const DAY_MS = 24 * 60 * 60 * 1000

export type NewVoiceKind = 'brand_new' | 'reemerging'

export type NewVoice = {
  id: string
  contact_id: string
  contact_name: string
  kind: NewVoiceKind
  message_id: string
  subject: string | null
  snippet: string | null
  sent_at: string
  days_ago: number
  // For re-emerging: how long the prior gap was. NULL for brand-new.
  gap_days: number | null
  tier: number | null
  href: string
}

type ContactRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  tier: number | null
}

type MessageRow = {
  id: string
  contact_id: string | null
  direction: 'inbound' | 'outbound' | null
  subject: string | null
  snippet: string | null
  sent_at: string
}

export async function findNewVoices(
  service: SupabaseClient,
  userId: string,
  opts?: { now?: Date },
): Promise<NewVoice[]> {
  const now = opts?.now ?? new Date()
  const recentStartIso = new Date(
    now.getTime() - RECENT_WINDOW_DAYS * DAY_MS,
  ).toISOString()
  const historyStartIso = new Date(
    now.getTime() - HISTORY_LOOKBACK_DAYS * DAY_MS,
  ).toISOString()

  const [contactsRes, messagesRes] = await Promise.all([
    service
      .from('contacts')
      .select('id, first_name, last_name, email, tier')
      .eq('user_id', userId)
      .limit(5000),
    service
      .from('messages')
      .select('id, contact_id, direction, subject, snippet, sent_at')
      .eq('user_id', userId)
      .eq('direction', 'inbound')
      .not('contact_id', 'is', null)
      .gte('sent_at', historyStartIso)
      .order('sent_at', { ascending: false })
      .limit(20000),
  ])

  if (contactsRes.error || messagesRes.error) return []
  const contacts = (contactsRes.data ?? []) as ContactRow[]
  const messages = (messagesRes.data ?? []) as MessageRow[]
  const contactsById = new Map(contacts.map((c) => [c.id, c]))

  // Group inbound messages by contact (newest-first).
  const byContact = new Map<string, MessageRow[]>()
  for (const m of messages) {
    if (!m.contact_id) continue
    const list = byContact.get(m.contact_id)
    if (list) list.push(m)
    else byContact.set(m.contact_id, [m])
  }

  const recentStartTs = new Date(recentStartIso).getTime()
  const results: NewVoice[] = []
  for (const [contactId, msgs] of byContact) {
    const contact = contactsById.get(contactId)
    if (!contact) continue
    const latest = msgs[0]
    if (!latest) continue
    const latestTs = new Date(latest.sent_at).getTime()
    if (!Number.isFinite(latestTs) || latestTs < recentStartTs) continue

    const earlier = msgs.slice(1).find((m) => {
      const ts = new Date(m.sent_at).getTime()
      return Number.isFinite(ts)
    })

    const name = nameOf(contact)
    const daysAgo = Math.max(
      0,
      Math.floor((now.getTime() - latestTs) / DAY_MS),
    )

    if (!earlier) {
      // No prior inbound in our 365d window → brand new.
      results.push({
        id: `nv:${contactId}:brand`,
        contact_id: contactId,
        contact_name: name,
        kind: 'brand_new',
        message_id: latest.id,
        subject: latest.subject,
        snippet: latest.snippet,
        sent_at: latest.sent_at,
        days_ago: daysAgo,
        gap_days: null,
        tier: contact.tier,
        href: `/contacts/${contactId}`,
      })
      continue
    }

    const earlierTs = new Date(earlier.sent_at).getTime()
    const gapDays = Math.floor((latestTs - earlierTs) / DAY_MS)
    if (gapDays >= REEMERGE_GAP_DAYS) {
      results.push({
        id: `nv:${contactId}:reemerge`,
        contact_id: contactId,
        contact_name: name,
        kind: 'reemerging',
        message_id: latest.id,
        subject: latest.subject,
        snippet: latest.snippet,
        sent_at: latest.sent_at,
        days_ago: daysAgo,
        gap_days: gapDays,
        tier: contact.tier,
        href: `/contacts/${contactId}`,
      })
    }
  }

  return results
    .sort((a, b) => {
      // Brand-new outranks re-emerging at the same recency; then most-recent.
      if (a.kind !== b.kind) return a.kind === 'brand_new' ? -1 : 1
      return a.days_ago - b.days_ago
    })
    .slice(0, MAX_ITEMS)
}

function nameOf(c: ContactRow): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.join(' ').trim()
  return c.email ?? 'Unknown contact'
}
