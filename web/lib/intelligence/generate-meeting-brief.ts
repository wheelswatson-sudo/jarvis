// ---------------------------------------------------------------------------
// generateMeetingBrief — LLM-generated narrative briefing for a calendar
// event. Cached on calendar_events.ai_brief so subsequent renders are
// free; regenerates when stale (>24h) or when matched-contact activity
// has moved since the last generation.
//
// Output shape persisted to ai_brief (jsonb):
//   {
//     "context":   "...",     // 1-2 sentences — scene-setting
//     "why_now":   "...",     // why this meeting matters at this moment
//     "open_with": "...",     // suggested opener / first move
//     "watch":     ["..."],   // 1-3 risks / things to listen for
//     "goal":      "...",     // user's likely goal for this meeting
//     "model":     "..."      // model id used (transparency)
//   }
//
// Provider-agnostic via streamCompletion. Defaults to Sonnet 4.6 — the
// quality of "why this matters now" reasoning is the whole point.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getModel,
  getProviderEnvKey,
  streamCompletion,
  type ChatMessage,
  type ModelInfo,
} from '../providers'

const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'
const FALLBACK_MODEL_ID = 'groq-llama-4-scout'
const RECENT_THREAD_MSGS = 5
const MAX_DESCRIPTION_CHARS = 2000

export type MeetingBriefNarrative = {
  context: string
  why_now: string
  open_with: string
  watch: string[]
  goal: string
  model?: string | null
  computed_at?: string
}

type RawAttendee = {
  email?: string | null
  name?: string | null
}

type EventRow = {
  id: string
  title: string | null
  description: string | null
  start_at: string
  end_at: string | null
  location: string | null
  attendees: unknown
  contact_id: string | null
}

type ContactRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  company: string | null
  title: string | null
  tier: number | null
  pipeline_stage: string | null
  pipeline_notes: string | null
  relationship_score: number | null
  last_interaction_at: string | null
}

type MessageRow = {
  id: string
  contact_id: string | null
  direction: 'inbound' | 'outbound' | null
  subject: string | null
  snippet: string | null
  sent_at: string
}

type CommitmentRow = {
  id: string
  contact_id: string | null
  description: string
  owner: 'me' | 'them' | null
  due_at: string | null
  status: string
}

export type GenerateMeetingBriefInput = {
  service: SupabaseClient
  userId: string
  userName: string
  eventId: string
}

export async function generateMeetingBrief(
  input: GenerateMeetingBriefInput,
): Promise<MeetingBriefNarrative | null> {
  const { service, userId, userName, eventId } = input

  const eventRes = await service
    .from('calendar_events')
    .select(
      'id, title, description, start_at, end_at, location, attendees, contact_id',
    )
    .eq('id', eventId)
    .eq('user_id', userId)
    .maybeSingle()
  const event = eventRes.data as EventRow | null
  if (!event) return null

  // Match attendees → contacts so we can pull commitments + recent messages.
  const attendees = parseAttendees(event.attendees)
  const emails = attendees.map((a) => a.email).filter(Boolean) as string[]
  if (emails.length === 0 && !event.contact_id) {
    // Pure self-event with no attendees — nothing useful to brief.
    return null
  }

  const contactsRes = await service
    .from('contacts')
    .select(
      'id, first_name, last_name, email, company, title, tier, pipeline_stage, pipeline_notes, relationship_score, last_interaction_at',
    )
    .eq('user_id', userId)
    .or(
      [
        emails.length > 0 ? `email.in.(${emails.map(quote).join(',')})` : null,
        event.contact_id ? `id.eq.${event.contact_id}` : null,
      ]
        .filter(Boolean)
        .join(','),
    )
  const contacts = (contactsRes.data ?? []) as ContactRow[]
  if (contacts.length === 0) return null

  const contactIds = contacts.map((c) => c.id)
  const [messagesRes, commitmentsRes] = await Promise.all([
    service
      .from('messages')
      .select('id, contact_id, direction, subject, snippet, sent_at')
      .eq('user_id', userId)
      .in('contact_id', contactIds)
      .order('sent_at', { ascending: false })
      .limit(RECENT_THREAD_MSGS * Math.max(1, contacts.length)),
    service
      .from('commitments')
      .select('id, contact_id, description, owner, due_at, status')
      .eq('user_id', userId)
      .eq('status', 'open')
      .in('contact_id', contactIds),
  ])

  const messages = (messagesRes.data ?? []) as MessageRow[]
  const commitments = (commitmentsRes.data ?? []) as CommitmentRow[]

  const model = await pickModel()
  const apiKey = getProviderEnvKey(model.provider)
  if (!apiKey) {
    console.warn(
      `[generate-meeting-brief] no API key for provider ${model.provider}; skipping`,
    )
    return null
  }

  const system = buildSystemPrompt(userName)
  const user = buildUserPrompt(event, contacts, messages, commitments)

  const messagesIn: ChatMessage[] = [{ role: 'user', content: user }]
  let raw = ''
  for await (const chunk of streamCompletion({
    apiKey,
    model,
    system,
    messages: messagesIn,
    maxTokens: 800,
  })) {
    raw += chunk
  }

  const parsed = parseNarrative(raw)
  if (!parsed) return null
  return {
    ...parsed,
    model: model.id,
    computed_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Cron entry point — finds upcoming meetings that need a fresh brief, then
// generates them. Bounded so a power user with a packed week doesn't blow
// the cron's time budget.
// ---------------------------------------------------------------------------

export type BriefRefreshSummary = {
  considered: number
  generated: number
  skipped: number
  errors: number
}

const REFRESH_HORIZON_HOURS = 72
const STALE_AFTER_HOURS = 24
const MAX_PER_RUN = 8

export async function refreshUpcomingMeetingBriefs(
  service: SupabaseClient,
  userId: string,
  userName: string,
): Promise<BriefRefreshSummary> {
  const now = Date.now()
  const horizon = new Date(now + REFRESH_HORIZON_HOURS * 60 * 60 * 1000).toISOString()
  const staleCutoff = new Date(now - STALE_AFTER_HOURS * 60 * 60 * 1000).toISOString()

  const upcomingRes = await service
    .from('calendar_events')
    .select('id, attendees, ai_brief, ai_brief_generated_at, contact_id')
    .eq('user_id', userId)
    .gte('start_at', new Date(now).toISOString())
    .lte('start_at', horizon)
    .order('start_at', { ascending: true })
    .limit(50)

  const upcoming = (upcomingRes.data ?? []) as Array<{
    id: string
    attendees: unknown
    ai_brief: unknown
    ai_brief_generated_at: string | null
    contact_id: string | null
  }>

  let generated = 0
  let skipped = 0
  let errors = 0

  for (const ev of upcoming) {
    if (generated >= MAX_PER_RUN) {
      skipped++
      continue
    }
    // Skip if already fresh.
    const fresh =
      ev.ai_brief != null &&
      ev.ai_brief_generated_at != null &&
      ev.ai_brief_generated_at >= staleCutoff
    if (fresh) {
      skipped++
      continue
    }
    // Skip events that won't yield a useful brief — no attendees AND no
    // bound contact_id. Self-events / blocks.
    const hasAttendees = parseAttendees(ev.attendees).length > 0
    if (!hasAttendees && !ev.contact_id) {
      skipped++
      continue
    }
    try {
      const narrative = await generateMeetingBrief({
        service,
        userId,
        userName,
        eventId: ev.id,
      })
      if (!narrative) {
        skipped++
        continue
      }
      const { error } = await service
        .from('calendar_events')
        .update({
          ai_brief: narrative,
          ai_brief_generated_at: narrative.computed_at ?? new Date().toISOString(),
        })
        .eq('id', ev.id)
        .eq('user_id', userId)
      if (error) {
        console.warn('[refreshUpcomingMeetingBriefs] update failed', error.message)
        errors++
        continue
      }
      generated++
    } catch (err) {
      errors++
      console.warn(
        '[refreshUpcomingMeetingBriefs] generation threw',
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { considered: upcoming.length, generated, skipped, errors }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt(userName: string): string {
  return `You are ${userName}'s executive briefer. ${userName} is about to walk into a meeting and needs a tight, opinionated read on it. Output an executive briefing — not a recap, not a summary of what we already know.

VOICE
- Direct, second-person ("you", "they"). No hedging, no "it might be helpful to consider".
- Specific over abstract. Reference the actual person, last specific exchange, dollar figure, deadline.
- Short. Each field is read in 5 seconds.

OUTPUT FORMAT — output ONLY this JSON object, no prose before or after:
{
  "context":   "<1-2 sentences setting the scene: who, where this relationship stands, recent inflection>",
  "why_now":   "<why this meeting matters at THIS moment — the live thing on the table>",
  "open_with": "<concrete first move: question, statement, or callback to last touch>",
  "watch":     ["<thing 1 to listen for or risk to avoid>", "<thing 2>"],
  "goal":      "<one-line guess at ${userName}'s goal for this meeting>"
}

RULES
- Never invent facts not in the context (no fictional numbers, dates, prior commitments).
- "watch" array: 1-3 items. Empty array is allowed if nothing specific.
- If you genuinely don't have enough signal, return short fields acknowledging the gap rather than padding with generic advice.`
}

function buildUserPrompt(
  event: EventRow,
  contacts: ContactRow[],
  messages: MessageRow[],
  commitments: CommitmentRow[],
): string {
  const startsIn = relativeTo(event.start_at)
  const meetingHeader = `MEETING
Title: ${event.title ?? '(no title)'}
Starts: ${startsIn}${event.location ? ` at ${event.location}` : ''}
Length: ${formatLength(event.start_at, event.end_at)}
${event.description ? `Description: ${event.description.slice(0, MAX_DESCRIPTION_CHARS)}` : ''}`

  const attendeeBlocks = contacts.map((c) => {
    const name =
      [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
      c.email ||
      'unknown'
    const role = [c.title, c.company].filter(Boolean).join(' at ')
    const tier =
      c.tier === 1
        ? 'inner-circle (T1)'
        : c.tier === 2
          ? 'close (T2)'
          : c.tier === 3
            ? 'active (T3)'
            : 'wider network'
    const score =
      c.relationship_score != null
        ? `${Math.round(c.relationship_score * 100)}%`
        : 'not computed'
    const lastTouch = c.last_interaction_at
      ? `last contact ${relativeTo(c.last_interaction_at)}`
      : 'no recorded contact'
    const stage = c.pipeline_stage ? ` · ${c.pipeline_stage}` : ''
    const notes = c.pipeline_notes
      ? `\n  notes: ${c.pipeline_notes.slice(0, 600)}`
      : ''

    const cContacts = commitments.filter((m) => m.contact_id === c.id)
    const commitmentBlock =
      cContacts.length === 0
        ? ''
        : `\n  open commitments:\n${cContacts
            .map((m) => {
              const owner = m.owner === 'me' ? 'YOU OWE' : 'THEY OWE'
              const due = m.due_at ? ` · due ${m.due_at.slice(0, 10)}` : ''
              return `    - [${owner}] ${m.description}${due}`
            })
            .join('\n')}`

    const cMessages = messages
      .filter((m) => m.contact_id === c.id)
      .slice(0, RECENT_THREAD_MSGS)
    const messagesBlock =
      cMessages.length === 0
        ? ''
        : `\n  recent thread (newest first):\n${cMessages
            .map((m) => {
              const dir = m.direction === 'outbound' ? 'YOU' : 'THEY'
              const text = (m.subject ?? m.snippet ?? '').trim().slice(0, 240)
              return `    - [${dir} · ${relativeTo(m.sent_at)}] ${text}`
            })
            .join('\n')}`

    return `- ${name}${role ? ` (${role})` : ''}${stage}
  ${tier} · score ${score} · ${lastTouch}${notes}${commitmentBlock}${messagesBlock}`
  })

  return `${meetingHeader}

ATTENDEES (matched to contacts)
${attendeeBlocks.join('\n\n')}`
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseNarrative(raw: string): Omit<MeetingBriefNarrative, 'model' | 'computed_at'> | null {
  // Find the JSON object in the response. Models occasionally wrap in
  // ```json fences or add a leading sentence; strip both.
  const trimmed = raw.trim()
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)
  const candidate = fenceMatch?.[1]?.trim() ?? extractFirstJsonObject(trimmed) ?? trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const context = typeof obj.context === 'string' ? obj.context.trim() : ''
  const why_now = typeof obj.why_now === 'string' ? obj.why_now.trim() : ''
  const open_with = typeof obj.open_with === 'string' ? obj.open_with.trim() : ''
  const goal = typeof obj.goal === 'string' ? obj.goal.trim() : ''
  const watchRaw = Array.isArray(obj.watch) ? obj.watch : []
  const watch = watchRaw
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 3)
  if (!context && !why_now && !open_with) return null
  return { context, why_now, open_with, watch, goal }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

async function pickModel(): Promise<ModelInfo> {
  const candidates = [DEFAULT_MODEL_ID, FALLBACK_MODEL_ID]
  for (const id of candidates) {
    const m = getModel(id)
    if (getProviderEnvKey(m.provider)) return m
  }
  return getModel(DEFAULT_MODEL_ID)
}

function parseAttendees(raw: unknown): { email: string; name: string | null }[] {
  if (!Array.isArray(raw)) return []
  const out: { email: string; name: string | null }[] = []
  const seen = new Set<string>()
  for (const a of raw as RawAttendee[]) {
    if (!a || typeof a.email !== 'string') continue
    const email = a.email.toLowerCase().trim()
    if (!email || seen.has(email)) continue
    seen.add(email)
    out.push({
      email,
      name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : null,
    })
  }
  return out
}

function quote(s: string): string {
  // Postgrest list value: strings need to be double-quoted if they contain
  // commas/spaces. Email addresses don't, but be defensive.
  return `"${s.replace(/"/g, '\\"')}"`
}

function relativeTo(iso: string | null): string {
  if (!iso) return 'unknown'
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return iso ?? 'unknown'
  const diff = ts - Date.now()
  const futureMins = Math.round(diff / 60_000)
  if (futureMins > 0 && futureMins < 60) return `in ${futureMins}m`
  if (futureMins >= 60 && futureMins < 24 * 60)
    return `in ${Math.round(futureMins / 60)}h`
  if (futureMins >= 24 * 60)
    return `in ${Math.round(futureMins / (24 * 60))}d`
  const pastMins = -futureMins
  if (pastMins < 60) return `${pastMins}m ago`
  if (pastMins < 24 * 60) return `${Math.round(pastMins / 60)}h ago`
  return `${Math.round(pastMins / (24 * 60))}d ago`
}

function formatLength(start: string, end: string | null): string {
  if (!end) return 'open-ended'
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '?'
  const mins = Math.max(0, Math.round((e - s) / 60_000))
  if (mins < 60) return `${mins} min`
  const hrs = Math.floor(mins / 60)
  const rem = mins - hrs * 60
  return rem === 0 ? `${hrs}h` : `${hrs}h ${rem}m`
}
