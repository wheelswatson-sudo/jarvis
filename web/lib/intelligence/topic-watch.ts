// ---------------------------------------------------------------------------
// findTopicWatchHits — surface when a contact's tracked topics show up in
// their own recent messages.
//
// Each contact can have `personal_details.topics_of_interest` (string[]).
// When one of those topics is mentioned in a message from/to that contact
// in the last 14 days, surface the hit. The EA framing is:
//
//   "Sarah mentioned 'fundraising' in her email yesterday — that's one of
//    her tracked topics, worth picking up in your reply."
//
// Pure keyword match (case-insensitive, word-boundary). No semantic
// similarity / no LLM — that's a future v2. Pure read of existing
// personal_details + messages tables.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PersonalDetails } from '../types'

const LOOKBACK_DAYS = 14
const MAX_ITEMS = 8
const MAX_TOPIC_LEN = 64
const MIN_TOPIC_LEN = 3
const MIN_RELATIONSHIP_SCORE = 0.2

export type TopicWatchHit = {
  id: string
  contact_id: string
  contact_name: string
  topic: string
  message_id: string
  direction: 'inbound' | 'outbound'
  subject: string | null
  snippet: string | null
  sent_at: string
  days_ago: number
  tier: number | null
  relationship_score: number | null
  href: string
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

type MessageRow = {
  id: string
  contact_id: string | null
  direction: 'inbound' | 'outbound' | null
  subject: string | null
  snippet: string | null
  sent_at: string
}

export async function findTopicWatchHits(
  service: SupabaseClient,
  userId: string,
  opts?: { lookbackDays?: number; now?: Date },
): Promise<TopicWatchHit[]> {
  const now = opts?.now ?? new Date()
  const lookback = opts?.lookbackDays ?? LOOKBACK_DAYS
  const lookbackIso = new Date(
    now.getTime() - lookback * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data: contactsData, error: contactsErr } = await service
    .from('contacts')
    .select(
      'id, first_name, last_name, email, tier, relationship_score, personal_details',
    )
    .eq('user_id', userId)
    .limit(5000)

  if (contactsErr) return []
  const contacts = (contactsData ?? []) as ContactRow[]

  // Build per-contact topic list, normalised + de-duped.
  type TopicSpec = { topic: string; regex: RegExp }
  const topicsByContact = new Map<string, TopicSpec[]>()
  for (const c of contacts) {
    if (!passesFloor(c)) continue
    const raw = c.personal_details?.topics_of_interest ?? []
    if (!Array.isArray(raw) || raw.length === 0) continue
    const specs: TopicSpec[] = []
    const seen = new Set<string>()
    for (const t of raw) {
      if (typeof t !== 'string') continue
      const normalized = t.trim()
      if (normalized.length < MIN_TOPIC_LEN || normalized.length > MAX_TOPIC_LEN) {
        continue
      }
      const key = normalized.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      specs.push({ topic: normalized, regex: buildTopicRegex(normalized) })
    }
    if (specs.length === 0) continue
    topicsByContact.set(c.id, specs)
  }

  if (topicsByContact.size === 0) return []

  const contactIds = Array.from(topicsByContact.keys())
  const { data: messagesData, error: messagesErr } = await service
    .from('messages')
    .select('id, contact_id, direction, subject, snippet, sent_at')
    .eq('user_id', userId)
    .in('contact_id', contactIds)
    .gte('sent_at', lookbackIso)
    .order('sent_at', { ascending: false })
    .limit(5000)

  if (messagesErr) return []
  const messages = (messagesData ?? []) as MessageRow[]
  const contactsById = new Map(contacts.map((c) => [c.id, c]))

  // For each contact, find the FIRST (= most-recent, since DESC sorted)
  // message that matches any of their topics. One hit per contact keeps
  // the surface scannable.
  const hitsByContact = new Map<string, TopicWatchHit>()
  for (const m of messages) {
    if (!m.contact_id || !m.direction) continue
    if (hitsByContact.has(m.contact_id)) continue
    const specs = topicsByContact.get(m.contact_id)
    if (!specs) continue
    const haystack = `${m.subject ?? ''} ${m.snippet ?? ''}`.toLowerCase()
    if (haystack.trim().length === 0) continue

    let matchedTopic: string | null = null
    for (const spec of specs) {
      if (spec.regex.test(haystack)) {
        matchedTopic = spec.topic
        break
      }
    }
    if (!matchedTopic) continue

    const contact = contactsById.get(m.contact_id)
    if (!contact) continue
    const name = nameOf(contact)
    const sentTs = new Date(m.sent_at).getTime()
    const daysAgo = Number.isFinite(sentTs)
      ? Math.max(0, Math.floor((now.getTime() - sentTs) / (24 * 60 * 60 * 1000)))
      : 0

    hitsByContact.set(m.contact_id, {
      id: `topic:${m.id}:${matchedTopic.toLowerCase()}`,
      contact_id: m.contact_id,
      contact_name: name,
      topic: matchedTopic,
      message_id: m.id,
      direction: m.direction,
      subject: m.subject,
      snippet: m.snippet,
      sent_at: m.sent_at,
      days_ago: daysAgo,
      tier: contact.tier,
      relationship_score: contact.relationship_score,
      href: `/contacts/${m.contact_id}`,
    })
  }

  return Array.from(hitsByContact.values())
    .sort((a, b) => {
      if (a.days_ago !== b.days_ago) return a.days_ago - b.days_ago
      const at = a.tier ?? 99
      const bt = b.tier ?? 99
      return at - bt
    })
    .slice(0, MAX_ITEMS)
}

// ---------------------------------------------------------------------------
// helpers — exported for testing
// ---------------------------------------------------------------------------

export function buildTopicRegex(topic: string): RegExp {
  const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Word boundary at both ends so "AI" doesn't match "trail" etc.
  return new RegExp(`\\b${escaped}\\b`, 'i')
}

function passesFloor(c: ContactRow): boolean {
  if (c.tier === 1 || c.tier === 2) return true
  if (c.relationship_score == null) return true
  return c.relationship_score >= MIN_RELATIONSHIP_SCORE
}

function nameOf(c: ContactRow): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.join(' ').trim()
  return c.email ?? 'Unknown contact'
}
