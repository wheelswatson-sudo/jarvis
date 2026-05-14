// ---------------------------------------------------------------------------
// findConnectorSuggestions — the killer EA move: "Mark mentioned needing a
// CFO; Jane is a CFO in your network. Make the intro?"
//
// v1 is pure keyword cross-reference, no LLM:
//
//   1. Extract topic keywords from contact A's recent inbound messages
//      (subjects + snippets; intersected against a small "intent
//      verbs" set so we surface intent, not chatter).
//   2. For each candidate topic, look across the user's network for
//      contact B whose `title`, `company`, or `topics_of_interest`
//      match the topic via word-boundary regex.
//   3. Filter: don't suggest B = A. Limit MAX_MATCHES_PER_REQUESTER so
//      one chatty inbox doesn't crowd everyone else.
//   4. Score by recency of A's mention + relationship_score of both
//      sides. Cap MAX_ITEMS.
//
// This is intentionally simple. Semantic matching (embeddings) is a
// future v2; this v1 catches the obvious wins.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PersonalDetails } from '../types'

const RECENT_WINDOW_DAYS = 14
const MAX_ITEMS = 6
const MAX_MATCHES_PER_REQUESTER = 2
const MIN_TOPIC_LEN = 3
const MIN_RELATIONSHIP_SCORE = 0.3

// "Intent" verbs — when one of these appears in a subject/snippet, the
// noun captured is much more likely to be an actual ask. Cheap heuristic
// to keep the keyword filter from matching every generic mention.
const INTENT_PATTERNS = [
  /\blooking for an? (\w+)/gi,
  /\bneed an? (\w+)/gi,
  /\bneed (?:a )?recommendation for an? (\w+)/gi,
  /\bany recommendations? for an? (\w+)/gi,
  /\bhiring an? (\w+)/gi,
  /\bsearching for an? (\w+)/gi,
  /\btrying to find an? (\w+)/gi,
]

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'for',
  'on',
  'with',
  'of',
  'and',
  'or',
])

export type ConnectorSuggestion = {
  id: string
  requester_contact_id: string
  requester_name: string
  match_contact_id: string
  match_name: string
  topic: string
  match_field: 'title' | 'topics_of_interest' | 'company'
  match_value: string
  message_id: string
  message_subject: string | null
  message_snippet: string | null
  message_sent_at: string
  days_ago: number
  requester_score: number | null
  match_score: number | null
  href: string
}

type ContactRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  title: string | null
  company: string | null
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

export async function findConnectorSuggestions(
  service: SupabaseClient,
  userId: string,
  opts?: { now?: Date },
): Promise<ConnectorSuggestion[]> {
  const now = opts?.now ?? new Date()
  const recentIso = new Date(
    now.getTime() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const [contactsRes, messagesRes] = await Promise.all([
    service
      .from('contacts')
      .select(
        'id, first_name, last_name, email, title, company, tier, relationship_score, personal_details',
      )
      .eq('user_id', userId)
      .limit(5000),
    service
      .from('messages')
      .select('id, contact_id, direction, subject, snippet, sent_at')
      .eq('user_id', userId)
      .eq('direction', 'inbound')
      .not('contact_id', 'is', null)
      .gte('sent_at', recentIso)
      .order('sent_at', { ascending: false })
      .limit(2000),
  ])

  if (contactsRes.error || messagesRes.error) return []
  const contacts = (contactsRes.data ?? []) as ContactRow[]
  const messages = (messagesRes.data ?? []) as MessageRow[]
  const contactsById = new Map(contacts.map((c) => [c.id, c]))

  // Step 1: extract topics from each requester's recent inbound msgs.
  type RequesterTopic = {
    contact: ContactRow
    topic: string
    message: MessageRow
  }
  const requesterTopics: RequesterTopic[] = []
  for (const m of messages) {
    if (!m.contact_id) continue
    const requester = contactsById.get(m.contact_id)
    if (!requester) continue
    if ((requester.relationship_score ?? 0) < MIN_RELATIONSHIP_SCORE) continue

    const text = `${m.subject ?? ''} ${m.snippet ?? ''}`
    const topics = extractTopics(text)
    for (const topic of topics) {
      requesterTopics.push({ contact: requester, topic, message: m })
    }
  }

  if (requesterTopics.length === 0) return []

  // Step 2: for each (requester, topic), find candidate matches.
  const pairsSeen = new Set<string>()
  const perRequester = new Map<string, number>()
  const suggestions: ConnectorSuggestion[] = []

  for (const rt of requesterTopics) {
    if ((perRequester.get(rt.contact.id) ?? 0) >= MAX_MATCHES_PER_REQUESTER) {
      continue
    }
    const topicRegex = buildTopicRegex(rt.topic)

    for (const candidate of contacts) {
      if (candidate.id === rt.contact.id) continue
      if ((candidate.relationship_score ?? 0) < MIN_RELATIONSHIP_SCORE) continue

      const matched = matchCandidate(candidate, topicRegex)
      if (!matched) continue

      const key = `${rt.contact.id}::${candidate.id}::${rt.topic.toLowerCase()}`
      if (pairsSeen.has(key)) continue
      pairsSeen.add(key)

      const sentTs = new Date(rt.message.sent_at).getTime()
      const daysAgo = Number.isFinite(sentTs)
        ? Math.max(
            0,
            Math.floor((now.getTime() - sentTs) / (24 * 60 * 60 * 1000)),
          )
        : 0

      suggestions.push({
        id: `connect:${rt.message.id}:${rt.contact.id}:${candidate.id}`,
        requester_contact_id: rt.contact.id,
        requester_name: nameOf(rt.contact),
        match_contact_id: candidate.id,
        match_name: nameOf(candidate),
        topic: rt.topic,
        match_field: matched.field,
        match_value: matched.value,
        message_id: rt.message.id,
        message_subject: rt.message.subject,
        message_snippet: rt.message.snippet,
        message_sent_at: rt.message.sent_at,
        days_ago: daysAgo,
        requester_score: rt.contact.relationship_score,
        match_score: candidate.relationship_score,
        href: `/contacts/${rt.contact.id}`,
      })
      perRequester.set(
        rt.contact.id,
        (perRequester.get(rt.contact.id) ?? 0) + 1,
      )
      if ((perRequester.get(rt.contact.id) ?? 0) >= MAX_MATCHES_PER_REQUESTER) {
        break
      }
    }
  }

  return suggestions
    .sort((a, b) => {
      // Soonest mentions first, then by combined relationship score.
      if (a.days_ago !== b.days_ago) return a.days_ago - b.days_ago
      const aScore = (a.requester_score ?? 0) + (a.match_score ?? 0)
      const bScore = (b.requester_score ?? 0) + (b.match_score ?? 0)
      return bScore - aScore
    })
    .slice(0, MAX_ITEMS)
}

// ---------------------------------------------------------------------------
// Extraction — exported for testing
// ---------------------------------------------------------------------------

export function extractTopics(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const topics: string[] = []
  for (const pattern of INTENT_PATTERNS) {
    // matchAll() is iterator-based and side-effect-free vs the old
    // stateful regex.exec API.
    for (const match of text.matchAll(pattern)) {
      const noun = (match[1] ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
      if (!noun) continue
      if (noun.length < MIN_TOPIC_LEN) continue
      if (STOPWORDS.has(noun)) continue
      if (seen.has(noun)) continue
      seen.add(noun)
      topics.push(noun)
    }
  }
  return topics
}

export function buildTopicRegex(topic: string): RegExp {
  const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'i')
}

function matchCandidate(
  candidate: ContactRow,
  regex: RegExp,
): { field: 'title' | 'topics_of_interest' | 'company'; value: string } | null {
  if (candidate.title && regex.test(candidate.title)) {
    return { field: 'title', value: candidate.title }
  }
  const topics = candidate.personal_details?.topics_of_interest ?? []
  if (Array.isArray(topics)) {
    for (const t of topics) {
      if (typeof t === 'string' && regex.test(t)) {
        return { field: 'topics_of_interest', value: t }
      }
    }
  }
  if (candidate.company && regex.test(candidate.company)) {
    return { field: 'company', value: candidate.company }
  }
  return null
}

function nameOf(c: ContactRow): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.join(' ').trim()
  return c.email ?? 'Unknown contact'
}
