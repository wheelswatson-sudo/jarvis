// ---------------------------------------------------------------------------
// Commitment extractor — Groq Llama 4 Scout reads raw email text and
// returns structured commitments + sentiment + key points + action items.
//
// Owner mapping: the caller's perspective is "self". We coerce the model's
// 'self'/'contact'/'mutual' labels to the commitments table's 'me'/'them'
// schema (mutual collapses to 'me' so it won't get lost — the user is on the
// hook either way).
// ---------------------------------------------------------------------------

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

export type ExtractedCommitment = {
  description: string
  due_at: string | null
  owner: 'self' | 'contact' | 'mutual'
  confidence: number
}

export type ExtractedSignals = {
  commitments: ExtractedCommitment[]
  sentiment: number
  key_points: string[]
  action_items: string[]
}

export type ContactContext = {
  name?: string | null
  email?: string | null
  company?: string | null
}

const EMPTY: ExtractedSignals = {
  commitments: [],
  sentiment: 0,
  key_points: [],
  action_items: [],
}

export async function extractCommitments(
  emailText: string,
  contact?: ContactContext,
): Promise<ExtractedSignals> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured')

  const trimmed = emailText.trim().slice(0, 12000)
  if (!trimmed) return EMPTY

  const contactLine = contact?.name || contact?.email
    ? `\nCounterparty: ${contact?.name ?? ''}${contact?.email ? ` <${contact.email}>` : ''}${contact?.company ? ` (${contact.company})` : ''}`.trim()
    : ''

  const prompt = `You read one email and extract structured signals. Return ONLY a JSON object — no prose, no fences.

Schema:
{
  "commitments": [{"description": string, "due_at": ISO-8601 string or null, "owner": "self"|"contact"|"mutual", "confidence": 0-1}],
  "sentiment": number from -1 (hostile) to 1 (warm),
  "key_points": string[] (3-5 items),
  "action_items": string[] (concrete next steps)
}

Rules:
- "self" = the reader committed. "contact" = the sender/recipient committed. "mutual" = both.
- Only extract genuine commitments ("I'll send X by Friday", "we agreed to ship Monday"). Skip pleasantries.
- due_at must be ISO-8601 with timezone (use UTC if unspecified). null when no date is implied.
- confidence reflects how explicit the commitment is.
- Empty arrays are valid. Sentiment defaults to 0 when neutral.${contactLine}

Email:
"""
${trimmed}
"""`

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You extract structured commitments from emails. Output JSON only.' },
        { role: 'user', content: prompt },
      ],
    }),
  })

  if (!res.ok) {
    throw new Error(`Groq error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) return EMPTY

  let parsed: Partial<ExtractedSignals>
  try {
    parsed = JSON.parse(content) as Partial<ExtractedSignals>
  } catch {
    return EMPTY
  }

  return {
    commitments: Array.isArray(parsed.commitments)
      ? parsed.commitments
          .filter((c) => c && typeof c.description === 'string' && c.description.trim())
          .map((c) => ({
            description: c.description.trim(),
            due_at: typeof c.due_at === 'string' ? c.due_at : null,
            owner: c.owner === 'contact' || c.owner === 'mutual' ? c.owner : 'self',
            confidence: typeof c.confidence === 'number'
              ? Math.max(0, Math.min(1, c.confidence))
              : 0.5,
          }))
      : [],
    sentiment: typeof parsed.sentiment === 'number'
      ? Math.max(-1, Math.min(1, parsed.sentiment))
      : 0,
    key_points: Array.isArray(parsed.key_points)
      ? parsed.key_points.filter((s): s is string => typeof s === 'string').slice(0, 5)
      : [],
    action_items: Array.isArray(parsed.action_items)
      ? parsed.action_items.filter((s): s is string => typeof s === 'string').slice(0, 10)
      : [],
  }
}
