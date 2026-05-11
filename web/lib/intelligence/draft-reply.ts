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
// Per-recipient style anchor — how many past outbound messages to this
// SPECIFIC contact we read for register calibration. We over-fetch a few
// (8 vs 5) so the register signal is statistically stable when present.
const RECIPIENT_STYLE_SAMPLE = 8
// General-network style anchor — used for cold-start when recipient
// history is thin. Same 5 as before.
const GENERAL_STYLE_SAMPLE = 5
// Strategy thresholds. Below MIN_RECIPIENT_SAMPLES we BLEND
// recipient + general; above MIN_RECIPIENT_ONLY we drop the general
// noise entirely and anchor on per-recipient samples only.
const MIN_RECIPIENT_SAMPLES = 1
const MIN_RECIPIENT_ONLY = 3
const MAX_BODY_CHARS = 16000

// Style-anchor strategy actually used for a draft. Exported so callers and
// downstream surfaces (drafts review UI, telemetry) can show it.
export type DraftStyleAnchor = 'recipient_only' | 'recipient_blend' | 'general'

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
  // How the model was style-anchored for this draft. Surfaces to the
  // review UI so the user knows whether the draft was tuned to THEM
  // specifically or to general voice.
  style_anchor: DraftStyleAnchor
  style_sample_count: number
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

  const [anchorRes, contactRes, threadRes, recipientStyleRes, generalStyleRes] =
    await Promise.all([
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
      // User's outbound to THIS contact — primary register signal. When
      // we have enough of these we anchor entirely on them, since people
      // talk to different people differently and a Watson-to-investor
      // tone is materially different from a Watson-to-Kris tone.
      service
        .from('messages')
        .select('sender, recipient, subject, snippet, body, sent_at')
        .eq('user_id', userId)
        .eq('contact_id', contactId)
        .eq('direction', 'outbound')
        .order('sent_at', { ascending: false })
        .limit(RECIPIENT_STYLE_SAMPLE),
      // User's recent outbound to ANY contact — cold-start fallback when
      // recipient history is thin. Still useful when blending.
      service
        .from('messages')
        .select('sender, recipient, subject, snippet, body, sent_at')
        .eq('user_id', userId)
        .eq('direction', 'outbound')
        .order('sent_at', { ascending: false })
        .limit(GENERAL_STYLE_SAMPLE),
    ])

  const anchor = anchorRes.data as MessageRow | null
  if (!anchor) throw new Error('anchor message not found')
  const contact = contactRes.data as ContactRow | null
  if (!contact) throw new Error('contact not found')

  const threadMsgs = (threadRes.data ?? []) as MessageRow[]
  type StyleSample = Pick<
    MessageRow,
    'sender' | 'recipient' | 'subject' | 'snippet' | 'body' | 'sent_at'
  >
  const recipientSamples = (recipientStyleRes.data ?? []) as StyleSample[]
  const generalSamples = (generalStyleRes.data ?? []) as StyleSample[]
  const { anchor: styleAnchor, samples: styleSamples } = pickStyleAnchor(
    recipientSamples,
    generalSamples,
  )

  const model = await pickModel(input.modelId)
  const apiKey = getProviderEnvKey(model.model.provider)
  if (!apiKey) {
    throw new Error(`No API key configured for provider ${model.model.provider}`)
  }

  const system = buildSystemPrompt(
    userName,
    userEmail,
    contact,
    styleSamples,
    styleAnchor,
  )
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
    reasoning: annotateReasoning(parsed.reasoning, styleAnchor, styleSamples.length),
    model: model.model,
    style_anchor: styleAnchor,
    style_sample_count: styleSamples.length,
  }
}

// ---------------------------------------------------------------------------
// Style anchor selection — picks WHICH samples to feed the model, based on
// how much prior recipient-specific history we have. Exported for testing.
// ---------------------------------------------------------------------------

export function pickStyleAnchor<
  T extends Pick<
    MessageRow,
    'sender' | 'recipient' | 'subject' | 'snippet' | 'body' | 'sent_at'
  >,
>(
  recipientSamples: T[],
  generalSamples: T[],
): { anchor: DraftStyleAnchor; samples: T[] } {
  const r = recipientSamples.length
  if (r >= MIN_RECIPIENT_ONLY) {
    return { anchor: 'recipient_only', samples: recipientSamples }
  }
  if (r >= MIN_RECIPIENT_SAMPLES) {
    // Blend: recipient-specific first (model leans on freshest signal),
    // then general samples to fill out the picture. Dedupe in case a
    // general sample happens to be one of the recipient ones.
    const seen = new Set<string>(
      recipientSamples.map(
        (m) => `${m.sent_at}|${(m.subject ?? '').slice(0, 50)}`,
      ),
    )
    const blended: T[] = [...recipientSamples]
    for (const m of generalSamples) {
      const key = `${m.sent_at}|${(m.subject ?? '').slice(0, 50)}`
      if (seen.has(key)) continue
      seen.add(key)
      blended.push(m)
    }
    return { anchor: 'recipient_blend', samples: blended }
  }
  return { anchor: 'general', samples: generalSamples }
}

function annotateReasoning(
  modelReasoning: string | null,
  anchor: DraftStyleAnchor,
  sampleCount: number,
): string | null {
  // Keep model's framing reasoning first if present, then append a short
  // provenance note for the user. Pure data — no editorialising.
  const provenance =
    anchor === 'recipient_only'
      ? `Anchored on ${sampleCount} past email${sampleCount === 1 ? '' : 's'} you sent to this contact.`
      : anchor === 'recipient_blend'
        ? `Blended anchor — ${sampleCount} samples, partial recipient history.`
        : 'Anchored on general voice — no prior emails to this contact yet.'
  if (!modelReasoning) return provenance
  return `${modelReasoning} · ${provenance}`
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  userName: string,
  userEmail: string,
  contact: ContactRow,
  sentMsgs: Pick<MessageRow, 'subject' | 'snippet' | 'body' | 'sent_at'>[],
  anchor: DraftStyleAnchor,
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

  const anchorLabel =
    anchor === 'recipient_only'
      ? `THESE ARE ${userName.toUpperCase()}'S EMAILS TO THIS SPECIFIC RECIPIENT — mirror this register exactly. The recipient relationship has its own tone (warmth, formality, opener style, sign-off). Match it.`
      : anchor === 'recipient_blend'
        ? `Mixed samples — the first few are emails to this specific recipient (lean on these for register), the rest are general voice. Prefer the recipient-specific samples when they conflict.`
        : `General voice samples — no emails to this specific recipient yet. Use the broader voice and adjust formality from the recipient's role/tier (below) and the recent thread.`

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

STYLE ANCHOR — ${anchorLabel}
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
