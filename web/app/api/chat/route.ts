import { NextResponse } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import {
  DEFAULT_MODEL_ID,
  getModel,
  getProviderEnvKey,
  streamCompletion,
  type ChatMessage,
} from '../../../lib/providers'
import type { Commitment, Contact, Interaction } from '../../../lib/types'

export const dynamic = 'force-dynamic'

const FALLBACK_MODEL_ID = 'groq-llama-4-maverick'

const MAX_TOKENS = 1024
const MAX_CONTACTS_IN_CONTEXT = 40
const MAX_COMMITMENTS_IN_CONTEXT = 30
const MAX_INTERACTIONS_IN_CONTEXT = 20

type RelationshipContext = {
  userName: string
  totals: {
    contacts: number
    openIOwe: number
    openTheyOwe: number
    decaying: number
    recent7d: number
  }
  topContacts: Array<{
    id: string
    name: string
    tier: number | null
    company: string | null
    title: string | null
    halfLifeDays: number | null
    sentimentSlope: number | null
    lastInteractionAt: string | null
    daysSinceLast: number | null
  }>
  iOwe: Array<{ description: string; due: string | null; contactName: string | null }>
  theyOwe: Array<{ description: string; due: string | null; contactName: string | null }>
  recentInteractions: Array<{
    contactName: string | null
    channel: string | null
    direction: string | null
    summary: string | null
    occurredAt: string
  }>
}

function parseMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input)) return null
  const out: ChatMessage[] = []
  for (const m of input) {
    if (!m || typeof m !== 'object') return null
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    if (role !== 'user' && role !== 'assistant') return null
    if (typeof content !== 'string' || !content.trim()) return null
    out.push({ role, content })
  }
  if (out.length === 0) return null
  if (out[out.length - 1]!.role !== 'user') return null
  return out
}

function daysBetween(iso: string | null, now: number): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((now - t) / (24 * 60 * 60 * 1000))
}

async function loadContext(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userEmail: string,
  userMetaName: string | null,
): Promise<RelationshipContext> {
  const now = Date.now()
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [contactsRes, commitmentsRes, interactionsRes] = await Promise.all([
    supabase
      .from('contacts')
      .select('*')
      .order('tier', { ascending: true, nullsFirst: false })
      .order('last_interaction_at', { ascending: false, nullsFirst: false })
      .limit(120),
    supabase
      .from('commitments')
      .select('id, contact_id, due_at, status, description')
      .eq('status', 'open'),
    supabase
      .from('interactions')
      .select('id, contact_id, channel, direction, summary, occurred_at')
      .gte('occurred_at', sevenDaysAgo)
      .order('occurred_at', { ascending: false })
      .limit(60),
  ])

  const contacts = (contactsRes.data ?? []) as Contact[]
  const commitments = (commitmentsRes.data ?? []) as Pick<
    Commitment,
    'id' | 'contact_id' | 'due_at' | 'status' | 'description'
  >[]
  const interactions = (interactionsRes.data ?? []) as Pick<
    Interaction,
    'id' | 'contact_id' | 'channel' | 'direction' | 'summary' | 'occurred_at'
  >[]

  const contactById = new Map(contacts.map((c) => [c.id, c]))

  const decaying = contacts.filter(
    (c) => c.half_life_days != null && c.half_life_days < 21,
  ).length

  const topContacts = contacts.slice(0, MAX_CONTACTS_IN_CONTEXT).map((c) => ({
    id: c.id,
    name: c.name,
    tier: c.tier,
    company: c.company,
    title: c.title,
    halfLifeDays: c.half_life_days,
    sentimentSlope: c.sentiment_slope,
    lastInteractionAt: c.last_interaction_at,
    daysSinceLast: daysBetween(c.last_interaction_at, now),
  }))

  const iOweAll: RelationshipContext['iOwe'] = []
  const theyOweAll: RelationshipContext['theyOwe'] = []
  for (const c of commitments) {
    const contactName = c.contact_id
      ? (contactById.get(c.contact_id)?.name ?? null)
      : null
    const desc = c.description.toLowerCase()
    const item = { description: c.description, due: c.due_at, contactName }
    if (desc.startsWith('they ') || desc.includes('they owe')) {
      theyOweAll.push(item)
    } else {
      iOweAll.push(item)
    }
  }

  const sortByDue = (
    a: { due: string | null },
    b: { due: string | null },
  ): number => {
    if (a.due && b.due) return a.due.localeCompare(b.due)
    if (a.due) return -1
    if (b.due) return 1
    return 0
  }
  iOweAll.sort(sortByDue)
  theyOweAll.sort(sortByDue)

  const recentInteractions = interactions
    .slice(0, MAX_INTERACTIONS_IN_CONTEXT)
    .map((i) => ({
      contactName: i.contact_id
        ? (contactById.get(i.contact_id)?.name ?? null)
        : null,
      channel: i.channel,
      direction: i.direction,
      summary: i.summary,
      occurredAt: i.occurred_at,
    }))

  return {
    userName: userMetaName?.trim() || userEmail.split('@')[0] || 'there',
    totals: {
      contacts: contacts.length,
      openIOwe: iOweAll.length,
      openTheyOwe: theyOweAll.length,
      decaying,
      recent7d: interactions.length,
    },
    topContacts,
    iOwe: iOweAll.slice(0, MAX_COMMITMENTS_IN_CONTEXT),
    theyOwe: theyOweAll.slice(0, MAX_COMMITMENTS_IN_CONTEXT),
    recentInteractions,
  }
}

function buildSystemPrompt(ctx: RelationshipContext): string {
  const { userName, totals, topContacts, iOwe, theyOwe, recentInteractions } = ctx

  const tierCounts = topContacts.reduce(
    (acc, c) => {
      if (c.tier === 1) acc.t1++
      else if (c.tier === 2) acc.t2++
      else if (c.tier === 3) acc.t3++
      return acc
    },
    { t1: 0, t2: 0, t3: 0 },
  )

  const contactsBlock = topContacts.length
    ? topContacts
        .map((c) => {
          const tierLabel =
            c.tier === 1 ? 'T1' : c.tier === 2 ? 'T2' : c.tier === 3 ? 'T3' : 'T?'
          const role = [c.title, c.company].filter(Boolean).join(' @ ') || '—'
          const halfLife = c.halfLifeDays != null ? `${c.halfLifeDays.toFixed(0)}d` : '—'
          const slope =
            c.sentimentSlope != null
              ? c.sentimentSlope > 0
                ? `+${c.sentimentSlope.toFixed(2)}`
                : c.sentimentSlope.toFixed(2)
              : '—'
          const last = c.daysSinceLast != null ? `${c.daysSinceLast}d ago` : 'never'
          const cooling =
            c.halfLifeDays != null && c.halfLifeDays < 21 ? ' [COOLING]' : ''
          return `- ${c.name} (${tierLabel}, ${role}) — half-life ${halfLife}, sentiment ${slope}, last ${last}${cooling}`
        })
        .join('\n')
    : '(no contacts loaded)'

  const fmtCommit = (c: {
    description: string
    due: string | null
    contactName: string | null
  }): string => {
    const who = c.contactName ? `[${c.contactName}] ` : ''
    const when = c.due ? ` (due ${c.due.slice(0, 10)})` : ''
    return `- ${who}${c.description}${when}`
  }

  const iOweBlock = iOwe.length ? iOwe.map(fmtCommit).join('\n') : '(none)'
  const theyOweBlock = theyOwe.length ? theyOwe.map(fmtCommit).join('\n') : '(none)'

  const interactionsBlock = recentInteractions.length
    ? recentInteractions
        .map((i) => {
          const who = i.contactName ?? 'unknown'
          const ch = i.channel ?? 'unknown'
          const dir = i.direction ?? '?'
          const date = i.occurredAt.slice(0, 10)
          const summary = i.summary ? ` — ${i.summary}` : ''
          return `- ${date} ${ch}/${dir} [${who}]${summary}`
        })
        .join('\n')
    : '(no recent interactions in last 7d)'

  return `You are Jarvis — a relationship intelligence advisor for ${userName}. You are not a generic CRM assistant. You have direct access to ${userName}'s relationship data and you reason from it.

# How you operate
- Be direct, specific, and actionable. Reference real people by name from the data below.
- Do not give generic relationship advice ("stay in touch with people you care about"). Instead, name the contact, cite the signal, and propose the next move.
- Short answers. No filler, no preamble. Skip "Great question!"-style openers.
- If the user asks something the data can't answer, say so in one sentence — don't fabricate.
- When suggesting outreach, make it concrete: who, why now, and a one-line opening they can actually send.

# Tier system
- **Tier 1 (inner circle)** — closest relationships; protect aggressively. Cooling here is an emergency.
- **Tier 2 (important)** — meaningful but not core; keep warm with cadence.
- **Tier 3 (maintain)** — light-touch network; don't over-invest.

# Half-life decay model
Every contact has a half-life in days — how long until the relationship's signal strength halves without new interaction. Half-life < 21d means the relationship is going cold and needs touch soon. Half-life > 60d means stable. Sentiment slope is the trend: positive = warming, negative = cooling.

# ${userName}'s relationship state right now
- ${totals.contacts} total contacts (T1: ${tierCounts.t1}, T2: ${tierCounts.t2}, T3: ${tierCounts.t3} in the top ${topContacts.length})
- ${totals.openIOwe} open commitments where ${userName} owes a reply/follow-up
- ${totals.openTheyOwe} open where someone owes ${userName}
- ${totals.decaying} relationships currently cooling (half-life < 21d)
- ${totals.recent7d} interactions logged in the last 7 days

## Top contacts (ordered by tier, then recency)
${contactsBlock}

## Open commitments — ${userName} owes
${iOweBlock}

## Open commitments — they owe ${userName}
${theyOweBlock}

## Recent interactions (last 7 days)
${interactionsBlock}

When ${userName} asks "who should I reach out to", "what's cooling", or "what I owe people", answer from the data above — don't ask them to remind you.`
}

async function loadModelAndKey(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<{ model: ReturnType<typeof getModel>; apiKey: string } | { error: string }> {
  const [profileRes, keysRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('preferred_model')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('user_api_keys')
      .select('provider, api_key, is_active')
      .eq('user_id', userId)
      .eq('is_active', true),
  ])

  const requested = getModel(profileRes.data?.preferred_model ?? DEFAULT_MODEL_ID)

  const userKey = (keysRes.data ?? []).find((k) => k.provider === requested.provider)
  if (userKey?.api_key) return { model: requested, apiKey: userKey.api_key }

  const envKey = getProviderEnvKey(requested.provider)
  if (envKey) return { model: requested, apiKey: envKey }

  const groqKey = process.env.GROQ_API_KEY
  if (groqKey) return { model: getModel(FALLBACK_MODEL_ID), apiKey: groqKey }

  return {
    error: `No API key configured for ${requested.provider} and no GROQ_API_KEY fallback set.`,
  }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { message?: unknown; messages?: unknown }
  try {
    body = (await request.json()) as { message?: unknown; messages?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  let messages = parseMessages(body.messages)
  if (!messages) {
    const single = typeof body.message === 'string' ? body.message.trim() : ''
    if (!single) {
      return NextResponse.json(
        { error: 'messages array (with final user turn) or message required' },
        { status: 400 },
      )
    }
    messages = [{ role: 'user', content: single }]
  }

  const resolved = await loadModelAndKey(supabase, user.id)
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 })
  }

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const userMetaName =
    typeof meta.full_name === 'string'
      ? meta.full_name
      : typeof meta.name === 'string'
        ? meta.name
        : null

  const context = await loadContext(supabase, user.email ?? '', userMetaName)
  const systemPrompt = buildSystemPrompt(context)

  const abortController = new AbortController()
  const encoder = new TextEncoder()
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of streamCompletion({
          apiKey: resolved.apiKey,
          model: resolved.model,
          system: systemPrompt,
          messages: messages!,
          maxTokens: MAX_TOKENS,
          signal: abortController.signal,
        })) {
          controller.enqueue(encoder.encode(chunk))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Stream error'
        controller.enqueue(encoder.encode(`\n\n[error: ${msg}]`))
      } finally {
        controller.close()
      }
    },
    cancel() {
      abortController.abort()
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
