import { NextResponse } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'
import { getServiceClient } from '../../../../../lib/supabase/service'
import { apiError } from '../../../../../lib/api-errors'
import {
  DEFAULT_MODEL_ID,
  getModel,
  getProviderEnvKey,
  streamCompletion,
} from '../../../../../lib/providers'
import type {
  Commitment,
  Contact,
  IntelligenceInsight,
  Interaction,
  MeetingBrief,
  PersonalDetails,
} from '../../../../../lib/types'

export const dynamic = 'force-dynamic'

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000))
}

function deterministicBrief(
  contact: Contact,
  interactions: Interaction[],
  commitments: Commitment[],
  insights: IntelligenceInsight[],
): MeetingBrief {
  const role = [contact.title, contact.company].filter(Boolean).join(' @ ')
  const pd: PersonalDetails = (contact.personal_details ?? {}) as PersonalDetails

  const who: string[] = []
  if (role) who.push(role)
  if (pd.spouse) who.push(`married to ${pd.spouse}`)
  if (pd.kids && pd.kids.length > 0) {
    who.push(`kids: ${pd.kids.join(', ')}`)
  }
  if (pd.interests && pd.interests.length > 0) {
    who.push(`into ${pd.interests.slice(0, 3).join(', ')}`)
  }

  const lastDays = daysSince(contact.last_interaction_at)
  const last = interactions[0]
  const recentParts: string[] = []
  if (lastDays != null) {
    recentParts.push(`Last spoke ${lastDays}d ago`)
  } else {
    recentParts.push('No recent interactions logged')
  }
  if (last?.summary) recentParts.push(last.summary)
  if (last?.key_points && last.key_points.length > 0) {
    recentParts.push(`Key points: ${last.key_points.slice(0, 3).join('; ')}`)
  }

  const openItems: string[] = []
  for (const c of commitments) {
    if (c.status !== 'open') continue
    const tag = c.owner === 'them' ? '[they owe]' : '[you owe]'
    const due = c.due_at ? ` (due ${c.due_at.slice(0, 10)})` : ''
    openItems.push(`${tag} ${c.description}${due}`)
  }

  const talkingPoints: string[] = []
  if (last?.follow_up_date) {
    talkingPoints.push(
      `Follow up on what you flagged for ${last.follow_up_date.slice(0, 10)}.`,
    )
  }
  if (last?.action_items && last.action_items.length > 0) {
    for (const a of last.action_items.slice(0, 3)) {
      if (a.completed) continue
      talkingPoints.push(`Confirm: ${a.description}`)
    }
  }
  if (pd.life_events && pd.life_events.length > 0) {
    talkingPoints.push(`Ask about: ${pd.life_events[0]!.event}`)
  }
  if (insights.length > 0) {
    talkingPoints.push(insights[0]!.title)
  }
  if (talkingPoints.length === 0) {
    talkingPoints.push('Open with a genuine personal check-in.')
  }

  let health = 'No score yet — log a few interactions to build signal.'
  const score = contact.relationship_score
  if (score != null) {
    const pct = Math.round(score * 100)
    if (pct >= 75) health = `Strong (${pct}%) — keep the cadence.`
    else if (pct >= 50) health = `Healthy (${pct}%) — small touches go far.`
    else if (pct >= 25)
      health = `Cooling (${pct}%) — this meeting is a chance to re-warm.`
    else health = `Cold (${pct}%) — re-establish trust first, no asks.`
  } else if (lastDays != null && lastDays > 60) {
    health = `Cold — ${lastDays}d since last contact.`
  } else if (lastDays != null && lastDays > 21) {
    health = `Cooling — ${lastDays}d since last contact.`
  }

  return {
    who_they_are: who.length > 0 ? who.join(' · ') : contact.name,
    recent_context: recentParts.join('. '),
    open_items: openItems,
    suggested_talking_points: talkingPoints,
    relationship_health: health,
  }
}

async function polishBriefWithLLM(
  apiKey: string,
  modelId: string,
  contact: Contact,
  base: MeetingBrief,
  interactions: Interaction[],
): Promise<MeetingBrief> {
  const model = getModel(modelId)
  const interactionDigest = interactions
    .slice(0, 5)
    .map((i) => {
      const date = i.occurred_at.slice(0, 10)
      const summary = i.summary ?? '(no summary)'
      const keys = i.key_points?.length
        ? ` Key: ${i.key_points.slice(0, 3).join('; ')}`
        : ''
      return `- ${date} ${i.type ?? i.channel ?? '?'} — ${summary}${keys}`
    })
    .join('\n')

  const prompt = `You are an executive assistant drafting a 30-second meeting prep brief for ${contact.name}.
Use ONLY the data below. Be specific, not generic. Output strict JSON with these keys:
who_they_are, recent_context, open_items (array of strings), suggested_talking_points (array of strings, max 4), relationship_health.

Current draft (replace anything weak):
${JSON.stringify(base, null, 2)}

Recent interactions:
${interactionDigest || '(none)'}

Personal details: ${JSON.stringify(contact.personal_details ?? {})}
Title/company: ${[contact.title, contact.company].filter(Boolean).join(' @ ') || '(unknown)'}
Last seen: ${contact.last_interaction_at ?? 'never'}

Output ONLY the JSON object, no markdown fences, no commentary.`

  let acc = ''
  try {
    for await (const chunk of streamCompletion({
      apiKey,
      model,
      system:
        'You produce concise, factual JSON briefs. No filler. No invented facts.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 800,
    })) {
      acc += chunk
    }
  } catch {
    return base
  }

  const cleaned = acc
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  try {
    const parsed = JSON.parse(cleaned) as Partial<MeetingBrief>
    return {
      who_they_are:
        typeof parsed.who_they_are === 'string'
          ? parsed.who_they_are
          : base.who_they_are,
      recent_context:
        typeof parsed.recent_context === 'string'
          ? parsed.recent_context
          : base.recent_context,
      open_items: Array.isArray(parsed.open_items)
        ? (parsed.open_items.filter((s) => typeof s === 'string') as string[])
        : base.open_items,
      suggested_talking_points: Array.isArray(parsed.suggested_talking_points)
        ? (parsed.suggested_talking_points.filter(
            (s) => typeof s === 'string',
          ) as string[])
        : base.suggested_talking_points,
      relationship_health:
        typeof parsed.relationship_health === 'string'
          ? parsed.relationship_health
          : base.relationship_health,
    }
  } catch {
    return base
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const { data: contactRow } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!contactRow) {
    return apiError(404, 'Contact not found', undefined, 'contact_not_found')
  }
  const contact = contactRow as Contact

  const [ixRes, comRes, insightsRes] = await Promise.all([
    supabase
      .from('interactions')
      .select('*')
      .eq('contact_id', id)
      .eq('user_id', user.id)
      .order('occurred_at', { ascending: false })
      .limit(5),
    supabase
      .from('commitments')
      .select('*')
      .eq('contact_id', id)
      .eq('user_id', user.id)
      .eq('status', 'open')
      .order('due_at', { ascending: true, nullsFirst: false }),
    supabase
      .from('intelligence_insights')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .contains('metadata', { contact_id: id })
      .order('priority', { ascending: false })
      .limit(3),
  ])

  const interactions = (ixRes.data ?? []) as Interaction[]
  const commitments = (comRes.data ?? []) as Commitment[]
  const insights = (insightsRes.data ?? []) as IntelligenceInsight[]

  const base = deterministicBrief(contact, interactions, commitments, insights)

  const profileRes = await supabase
    .from('profiles')
    .select('preferred_model')
    .eq('id', user.id)
    .maybeSingle()
  const modelId = profileRes.data?.preferred_model ?? DEFAULT_MODEL_ID
  const model = getModel(modelId)
  const apiKey = getProviderEnvKey(model.provider)

  const brief =
    apiKey != null
      ? await polishBriefWithLLM(apiKey, modelId, contact, base, interactions)
      : base

  // Cache the brief (best-effort; service role since meeting_briefs has no
  // user-side INSERT policy).
  const svc = getServiceClient()
  if (svc) {
    void svc.from('meeting_briefs').insert({
      user_id: user.id,
      contact_id: id,
      brief,
    })
  }

  return NextResponse.json({ brief, generated_at: new Date().toISOString() })
}
