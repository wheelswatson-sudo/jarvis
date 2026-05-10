// ---------------------------------------------------------------------------
// generateDraftReply — produce a contextual reply to an inbound (or stalled
// outbound) message, in the user's voice.
//
// Pulls last-thread context + the user's recent sent messages to anchor
// tone, then asks the model for a structured response with subject, body,
// and a one-line reasoning trace. Reasoning is surfaced in the review UI
// so the user can sanity-check the framing before sending.
//
// Provider-agnostic: reuses streamCompletion from lib/providers and
// collects the stream into a single string. Defaults to Haiku for cost,
// caller can override.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getModel,
  getProviderEnvKey,
  streamCompletion,
  type ChatMessage,
  type ModelInfo,
} from '../providers'

// Default to Sonnet 4.6 — drafts in the user's voice need a model that can
// match register, not just generate plausible English. Falls back to the
// chat default (Groq) when no Anthropic key is configured.
const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'
const FALLBACK_MODEL_ID = 'groq-llama-4-scout'
const RECENT_THREAD_MSGS = 5
const USER_STYLE_SAMPLE = 5
const MAX_BODY_CHARS = 16000

export type DraftReplyInput = {
  service: SupabaseClient
  userId: string
  userName: string
  userEmail: string
  // The message we're replying to. For a stalled-outbound nudge, this is
  // the user's last outbound to that contact (we'll frame the draft as a
  // follow-up to that).
  messageId: string
  contactId: string
  modelId?: string
}

export type DraftReplyOutput = {
  subject: string | null
  body: string
  reasoning: string | null
  model: ModelInfo
}

type MessageRow = {
  id: string
  contact_id: string | null
  direction: 'inbound' | 'outbound' | null
  sender: string | null
  recipient: string | null
  subject: string | null
  snippet: string | null
  body: string | null
  sent_at: string
  thread_id: string | null
}

type ContactRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  company: string | null
  title: string | null
  tier: number | null
  relationship_score: number | null
  last_interaction_at: string | null
}

export async function generateDraftReply(
  input: DraftReplyInput,
): Promise<DraftReplyOutput> {
  const { service, userId, userName, userEmail, messageId, contactId } = input

  const [anchorRes, contactRes, threadRes, sentRes] = await Promise.all([
    service
      .from('messages')
      .select(
        'id, contact_id, direction, sender, recipient, subject, snippet, body, sent_at, thread_id',
      )
      .eq('id', messageId)
      .eq('user_id', userId)
      .maybeSingle(),
    service
      .from('contacts')
      .select(
        'id, first_name, last_name, email, company, title, tier, relationship_score, last_interaction_at',
      )
      .eq('id', contactId)
      .eq('user_id', userId)
      .maybeSingle(),
    // Last few messages with this contact for thread context.
    service
      .from('messages')
      .select(
        'id, direction, sender, recipient, subject, snippet, body, sent_at',
      )
      .eq('user_id', userId)
      .eq('contact_id', contactId)
      .order('sent_at', { ascending: false })
      .limit(RECENT_THREAD_MSGS),
    // User's recent outbound to ANY contact for tone calibration.
    service
      .from('messages')
      .select('sender, recipient, subject, snippet, body, sent_at')
      .eq('user_id', userId)
      .eq('direction', 'outbound')
      .order('sent_at', { ascending: false })
      .limit(USER_STYLE_SAMPLE),
  ])

  const anchor = anchorRes.data as MessageRow | null
  if (!anchor) throw new Error('anchor message not found')
  const contact = contactRes.data as ContactRow | null
  if (!contact) throw new Error('contact not found')

  const threadMsgs = (threadRes.data ?? []) as MessageRow[]
  const sentMsgs = (sentRes.data ?? []) as Pick<
    MessageRow,
    'sender' | 'recipient' | 'subject' | 'snippet' | 'body' | 'sent_at'
  >[]

  const model = await pickModel(input.modelId)
  const apiKey = getProviderEnvKey(model.model.provider)
  if (!apiKey) {
    throw new Error(`No API key configured for provider ${model.model.provider}`)
  }

  const system = buildSystemPrompt(userName, userEmail, contact, sentMsgs)
  const user = buildUserPrompt(anchor, threadMsgs)

  const messages: ChatMessage[] = [{ role: 'user', content: user }]
  let raw = ''
  for await (const chunk of streamCompletion({
    apiKey,
    model: model.model,
    system,
    messages,
    maxTokens: 1200,
  })) {
    raw += chunk
  }

  const parsed = parseDraftOutput(raw)
  return {
    subject: parsed.subject,
    body: parsed.body.slice(0, MAX_BODY_CHARS),
    reasoning: parsed.reasoning,
    model: model.model,
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  userName: string,
  userEmail: string,
  contact: ContactRow,
  sentMsgs: Pick<MessageRow, 'subject' | 'snippet' | 'body' | 'sent_at'>[],
): string {
  const styleAnchor =
    sentMsgs.length === 0
      ? '(no prior sent messages available — keep it concise and direct)'
      : sentMsgs
          .map((m, i) => {
            const text = (m.body ?? m.snippet ?? '').trim().slice(0, 600)
            return `--- sample ${i + 1} (${formatRelative(m.sent_at)}) ---\n${text}`
          })
          .join('\n\n')

  const contactName =
    [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() ||
    contact.email ||
    'this contact'
  const tierLabel =
    contact.tier === 1
      ? 'inner circle (T1)'
      : contact.tier === 2
        ? 'close (T2)'
        : contact.tier === 3
          ? 'active network (T3)'
          : 'wider network'
  const role =
    [contact.title, contact.company].filter(Boolean).join(' at ') || 'unknown role'
  const score =
    contact.relationship_score != null
      ? `${Math.round(contact.relationship_score * 100)}%`
      : 'not yet computed'

  return `You are drafting an email reply on behalf of ${userName} (${userEmail}). Output a reply that sounds like ${userName}, not like an AI assistant.

VOICE RULES
- Match the tone, length, and rhythm of ${userName}'s past sent messages below. Mirror their typical opener, closer, and use of contractions.
- No filler ("Hope this finds you well", "I wanted to reach out", "Just circling back"). Get to the point.
- Match the recipient's register — formal stays formal, casual stays casual.
- Don't restate what the other person said in their email. They wrote it. Move the conversation forward.
- If the inbound message has no clear ask, write a short acknowledgement that invites the next move.
- Never invent facts (dates, numbers, attachments, prior commitments) that aren't in the context provided.

RECIPIENT
- ${contactName} (${contact.email ?? 'no email'})
- ${role}
- Relationship: ${tierLabel} · score ${score}

${userName}'S RECENT SENT MESSAGES — use as the style anchor
${styleAnchor}

OUTPUT FORMAT — output ONLY this, nothing before or after
SUBJECT: <new subject or "—" if continuing the thread>
REASONING: <one short sentence explaining your framing choice>
---
<the reply body>`
}

function buildUserPrompt(
  anchor: MessageRow,
  threadMsgs: MessageRow[],
): string {
  const threadOlderToNewer = [...threadMsgs].sort(
    (a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime(),
  )
  const threadBlock =
    threadOlderToNewer.length === 0
      ? '(no prior thread context)'
      : threadOlderToNewer
          .map((m) => {
            const dir = m.direction === 'outbound' ? 'YOU' : 'THEY'
            const text = (m.body ?? m.snippet ?? '').trim().slice(0, 800)
            return `[${dir} · ${formatRelative(m.sent_at)}] ${m.subject ? `${m.subject}\n` : ''}${text}`
          })
          .join('\n\n')

  const anchorText = (anchor.body ?? anchor.snippet ?? '').trim().slice(0, 4000)
  const anchorRole = anchor.direction === 'outbound' ? 'your last outbound' : 'their inbound'

  return `Draft a reply.

THE MESSAGE TO REPLY TO (${anchorRole})
From: ${anchor.sender ?? 'unknown'}
Subject: ${anchor.subject ?? '(no subject)'}
Sent: ${formatRelative(anchor.sent_at)}

${anchorText}

PRIOR THREAD WITH THIS CONTACT (oldest first)
${threadBlock}`
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseDraftOutput(raw: string): {
  subject: string | null
  reasoning: string | null
  body: string
} {
  const text = raw.trim()
  // Find the body separator. Models sometimes add extra dashes — accept any
  // line of 3+ dashes as the divider.
  const lines = text.split(/\r?\n/)
  let separatorIdx = lines.findIndex((l) => /^-{3,}\s*$/.test(l.trim()))
  if (separatorIdx === -1) {
    // No separator — treat the whole output as body.
    return { subject: null, reasoning: null, body: text }
  }
  const header = lines.slice(0, separatorIdx).join('\n')
  const body = lines.slice(separatorIdx + 1).join('\n').trim()

  const subjectMatch = header.match(/^SUBJECT:\s*(.+)$/im)
  const reasoningMatch = header.match(/^REASONING:\s*(.+)$/im)
  const rawSubject = subjectMatch?.[1]?.trim() ?? null
  const subject =
    rawSubject && rawSubject !== '—' && rawSubject !== '-' ? rawSubject : null

  return {
    subject,
    reasoning: reasoningMatch?.[1]?.trim() ?? null,
    body,
  }
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

async function pickModel(
  requestedId: string | undefined,
): Promise<{ model: ModelInfo }> {
  const candidates = [requestedId, DEFAULT_MODEL_ID, FALLBACK_MODEL_ID]
  for (const id of candidates) {
    if (!id) continue
    const m = getModel(id)
    if (getProviderEnvKey(m.provider)) return { model: m }
  }
  // Last-resort: return whatever getModel resolves the default to. Caller
  // checks the env key and throws if missing.
  return { model: getModel(DEFAULT_MODEL_ID) }
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return iso
  const days = Math.round((Date.now() - ts) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}
