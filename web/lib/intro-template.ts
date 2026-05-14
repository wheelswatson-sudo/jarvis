import type { Contact, PersonalDetails } from './types'
import { contactName } from './format'

// Deterministic double-opt-in intro email. No LLM — every input maps to
// the same output, which keeps drafts auditable and avoids billing the
// user's API quota for boilerplate.
//
// The double-opt-in pattern: send one email to both parties at once, ask
// each side to opt-in by replying before sharing contact details. The
// draft therefore stops short of dropping phone numbers / personal emails
// into the body — it gives just enough context that both sides can decide.

export type IntroTemplateInput = {
  source: Contact
  target: Contact
  // Why the user wants to make this intro — pulled from the commitment
  // description, the user-supplied form, or both. Optional; if absent,
  // the template falls back to a generic one-liner.
  reason?: string | null
  // The user themselves, so the signature reflects them rather than a
  // bare "—". Pulled from auth.user metadata at the call site.
  senderName?: string | null
}

export type IntroTemplateOutput = {
  subject: string
  body: string
}

function shortPersonalLine(c: Contact): string {
  const parts: string[] = []
  if (c.title) parts.push(c.title)
  if (c.company) parts.push(`at ${c.company}`)
  const role = parts.join(' ')
  const details = c.personal_details as PersonalDetails | null
  // One-sentence "what they care about" — pull from topics_of_interest
  // or interests, capped at the first three.
  const interests = [
    ...(details?.topics_of_interest ?? []),
    ...(details?.interests ?? []),
  ]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .slice(0, 3)
  const tail = interests.length > 0 ? ` Interests: ${interests.join(', ')}.` : ''
  return role ? `${role}.${tail}` : tail.trim()
}

export function buildIntroDraft({
  source,
  target,
  reason,
  senderName,
}: IntroTemplateInput): IntroTemplateOutput {
  const sourceName = contactName(source)
  const targetName = contactName(target)
  const sourceFirst = source.first_name?.trim() || sourceName.split(' ')[0]
  const targetFirst = target.first_name?.trim() || targetName.split(' ')[0]

  const subject = `Intro: ${sourceFirst} <> ${targetFirst}`

  const sourceLine = shortPersonalLine(source)
  const targetLine = shortPersonalLine(target)
  const why = reason?.trim()
  const reasonLine = why
    ? `I thought you two should know each other because ${why}.`
    : `I've been meaning to connect the two of you — there's good overlap.`

  const signOff = senderName?.trim() || '—'

  const body = [
    `${sourceFirst}, meet ${targetFirst}.`,
    `${targetFirst}, meet ${sourceFirst}.`,
    '',
    reasonLine,
    '',
    sourceLine
      ? `${sourceFirst}: ${sourceLine}`
      : `${sourceFirst}: I've worked with ${sourceFirst} on a few projects.`,
    targetLine
      ? `${targetFirst}: ${targetLine}`
      : `${targetFirst}: ${targetFirst} is someone I think highly of.`,
    '',
    `I'll let you two take it from here. Reply-all if you'd like to set up a call — no pressure if the timing isn't right.`,
    '',
    signOff,
  ].join('\n')

  return { subject, body }
}
