import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { apiError } from '../../../../lib/api-errors'
import { trackEvent } from '../../../../lib/events'
import type { ActionItem, Contact, InteractionType } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

// Heuristic transcript parser. Supports common formats:
//   - Otter.ai: "[Speaker Name 00:01] said something"
//   - Fireflies: "Speaker (00:01): said something"
//   - Google Meet / Zoom: "Speaker Name: said something"
//   - Read.ai: "Action items:" / "Key takeaways:" / "Decisions:" sections
//
// Output is best-effort and shown to the user for confirmation before insert.

type ParsedTranscript = {
  source: string
  participants: string[]
  date: string | null
  key_points: string[]
  action_items: ActionItem[]
  decisions: string[]
  summary: string
  raw_excerpt: string
}

type ScanResult = ParsedTranscript & {
  matched_contact_id: string | null
  matched_contact_name: string | null
  match_confidence: 'high' | 'medium' | 'low' | 'none'
}

const SOURCE_HINTS: Array<{ key: string; patterns: RegExp[] }> = [
  { key: 'otter', patterns: [/otter\.ai/i, /\boTranscribe\b/i] },
  { key: 'fireflies', patterns: [/fireflies\.ai/i, /\bFireflies\b/i] },
  { key: 'read', patterns: [/read\.ai/i, /\bRead\.ai\b/i] },
  { key: 'zoom', patterns: [/zoom\.us/i, /\bZoom Meeting\b/i] },
  { key: 'google_meet', patterns: [/meet\.google\.com/i, /\bGoogle Meet\b/i] },
  { key: 'teams', patterns: [/microsoft\s*teams/i, /\bTeams meeting\b/i] },
]

function detectSource(text: string): string {
  for (const s of SOURCE_HINTS) {
    if (s.patterns.some((p) => p.test(text))) return s.key
  }
  return 'unknown'
}

function extractDate(text: string): string | null {
  const m = text.match(
    /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(\d{2,4})|((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i,
  )
  if (!m) return null
  const raw = m[0]
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function extractParticipants(text: string): string[] {
  const names = new Set<string>()
  const speakerPatterns = [
    /^([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,2})\s*\(\d+:\d+\)\s*:/gm,
    /^([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,2})\s+\d+:\d+/gm,
    /^([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,2})\s*:\s/gm,
    /\[([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,2})\s+\d+:\d+\]/g,
  ]
  for (const re of speakerPatterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const n = m[1]?.trim()
      if (n && n.length >= 2 && n.length <= 60) names.add(n)
    }
  }
  return Array.from(names).slice(0, 20)
}

function extractSection(text: string, heading: RegExp): string[] {
  const start = text.search(heading)
  if (start < 0) return []
  const after = text.slice(start)
  const next = after.slice(after.search(/\n/)).match(
    /\n([A-Z][^\n]{2,40}:|\n\s*\n)/,
  )
  const block = next ? after.slice(0, after.indexOf(next[0])) : after
  return block
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/^[\s\-\*•\d\.\)]+/, '').trim())
    .filter((l) => l.length > 4 && l.length < 400)
    .slice(0, 12)
}

function extractActionItems(text: string): ActionItem[] {
  const lines = extractSection(
    text,
    /^(action items?|next steps?|to-?dos?|todos?)\s*:?\s*$/im,
  )
  const items: ActionItem[] = []
  for (const line of lines) {
    const owner: 'me' | 'them' = /\b(I|me|my|i'?ll|we'?ll|owe)\b/i.test(line)
      ? 'me'
      : 'them'
    const dueMatch = line.match(
      /(?:by|before|due)\s+([A-Za-z0-9 ,\/\-]+?)(?:[\.,]|$)/i,
    )
    let due: string | null = null
    if (dueMatch) {
      const d = new Date(dueMatch[1]!)
      if (!Number.isNaN(d.getTime())) due = d.toISOString()
    }
    items.push({ description: line, owner, due_date: due, completed: false })
  }
  return items
}

function extractKeyPoints(text: string): string[] {
  const candidates = [
    /^(key (?:takeaways?|points?)|highlights?|summary|topics?)\s*:?\s*$/im,
    /^(discussion points?|main points?)\s*:?\s*$/im,
  ]
  for (const re of candidates) {
    const out = extractSection(text, re)
    if (out.length > 0) return out
  }
  return []
}

function extractDecisions(text: string): string[] {
  return extractSection(text, /^(decisions?|agreed|conclusions?)\s*:?\s*$/im)
}

function buildSummary(
  participants: string[],
  keyPoints: string[],
  raw: string,
): string {
  if (keyPoints.length > 0) return keyPoints.slice(0, 2).join('. ')
  const firstSentence = raw
    .replace(/^[A-Z][a-zA-Z'\-]+\s+\d+:\d+\s*:/, '')
    .split(/[.!?]\s/)[0]
    ?.slice(0, 240)
  if (firstSentence && firstSentence.length > 20) return firstSentence
  if (participants.length > 0) {
    return `Meeting with ${participants.slice(0, 3).join(', ')}.`
  }
  return 'Imported transcript.'
}

function parseTranscript(text: string): ParsedTranscript {
  const source = detectSource(text)
  const participants = extractParticipants(text)
  const date = extractDate(text)
  const keyPoints = extractKeyPoints(text)
  const actionItems = extractActionItems(text)
  const decisions = extractDecisions(text)
  const summary = buildSummary(participants, keyPoints, text)
  return {
    source,
    participants,
    date,
    key_points: keyPoints,
    action_items: actionItems,
    decisions,
    summary,
    raw_excerpt: text.slice(0, 1000),
  }
}

type ContactMatchRow = Pick<Contact, 'id' | 'first_name' | 'last_name' | 'email'>

function fullName(c: ContactMatchRow): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
}

function matchContact(
  participants: string[],
  contacts: ContactMatchRow[],
): { id: string | null; name: string | null; confidence: ScanResult['match_confidence'] } {
  if (participants.length === 0 || contacts.length === 0) {
    return { id: null, name: null, confidence: 'none' }
  }
  const norm = (s: string) => s.toLowerCase().trim()
  const byFull = new Map<string, ContactMatchRow>()
  const byFirst = new Map<string, ContactMatchRow>()
  for (const c of contacts) {
    const full = norm(fullName(c))
    if (full && !byFull.has(full)) byFull.set(full, c)
    const first = norm(c.first_name ?? '').split(/\s+/)[0]
    if (first && !byFirst.has(first)) byFirst.set(first, c)
  }

  for (const p of participants) {
    const n = norm(p)
    const full = byFull.get(n)
    if (full) return { id: full.id, name: fullName(full), confidence: 'high' }
  }
  for (const p of participants) {
    const first = norm(p).split(/\s+/)[0]
    const m = first ? byFirst.get(first) : undefined
    if (m) return { id: m.id, name: fullName(m), confidence: 'medium' }
  }
  return { id: null, name: null, confidence: 'low' }
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
  }
  const b = (body ?? {}) as Record<string, unknown>

  const text = typeof b.text === 'string' ? b.text : null
  const commit = b.commit === true

  if (!text || text.trim().length < 20) {
    return apiError(
      400,
      'text required (paste full transcript)',
      undefined,
      'missing_text',
    )
  }

  if (text.length > 200_000) {
    return apiError(
      413,
      'transcript too large (max ~200kb)',
      undefined,
      'too_large',
    )
  }

  const parsed = parseTranscript(text)

  const { data: contactsData } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, email')
    .eq('user_id', user.id)
  const contacts = (contactsData ?? []) as ContactMatchRow[]
  const match = matchContact(parsed.participants, contacts)

  const result: ScanResult = {
    ...parsed,
    matched_contact_id: match.id,
    matched_contact_name: match.name,
    match_confidence: match.confidence,
  }

  // Preview-only by default. Set commit=true to actually insert.
  if (!commit) {
    return NextResponse.json({ preview: result })
  }

  if (!match.id) {
    return apiError(
      400,
      'No contact match — pass contact_id explicitly or create the contact first',
      result,
      'no_contact_match',
    )
  }

  const overrideContactId =
    typeof b.contact_id === 'string' ? b.contact_id : match.id

  const occurredAt = parsed.date ?? new Date().toISOString()
  const type: InteractionType = 'meeting'

  const { data: inserted, error } = await supabase
    .from('interactions')
    .insert({
      user_id: user.id,
      contact_id: overrideContactId,
      type,
      channel: 'meeting',
      direction: null,
      summary: parsed.summary,
      key_points: parsed.key_points,
      action_items: parsed.action_items,
      transcript_data: {
        source: parsed.source,
        participants: parsed.participants,
        decisions: parsed.decisions,
        raw_excerpt: parsed.raw_excerpt,
      },
      source: `transcript:${parsed.source}`,
      occurred_at: occurredAt,
    })
    .select('*')
    .single()

  if (error) return apiError(400, error.message, undefined, 'insert_failed')

  // Auto-create commitments for action items where owner is 'me'.
  const myItems = parsed.action_items.filter(
    (a) => a.owner === 'me' && !a.completed,
  )
  if (myItems.length > 0) {
    await supabase.from('commitments').insert(
      myItems.map((a) => ({
        user_id: user.id,
        contact_id: overrideContactId,
        interaction_id: inserted.id,
        description: a.description,
        due_at: a.due_date ?? null,
        owner: 'me',
        // commitments.direction is NOT NULL in prod; mirror owner.
        direction: 'me',
        status: 'open' as const,
      })),
    )
  }

  await supabase
    .from('contacts')
    .update({ last_interaction_at: occurredAt })
    .eq('id', overrideContactId)

  void trackEvent({
    userId: user.id,
    eventType: 'import_completed',
    contactId: overrideContactId,
    metadata: {
      source: 'transcript',
      transcript_source: parsed.source,
      action_items: parsed.action_items.length,
      key_points: parsed.key_points.length,
    },
  })

  return NextResponse.json({
    interaction: inserted,
    commitments_created: myItems.length,
    parsed: result,
  })
}
