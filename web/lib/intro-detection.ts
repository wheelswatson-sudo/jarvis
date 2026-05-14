// Detect intro opportunities from natural-language commitment descriptions.
// Deterministic — pure string matching, no LLM. The thresholds are loose
// because we'd rather surface a false positive (user dismisses) than miss
// a real intro intent (user has to remember manually).

const INTRO_PATTERNS: RegExp[] = [
  // "introduce X to Y", "intro X to Y"
  /\b(?:introduce|intro)\b[\s\S]{0,80}\bto\b/i,
  // "connect them with", "connect X with Y"
  /\bconnect\b[\s\S]{0,40}\b(?:with|to)\b/i,
  // "put them in touch", "put X in touch with Y"
  /\bput\b[\s\S]{0,40}\bin touch\b/i,
  // "warm intro to", "make an intro"
  /\b(?:warm\s+intro|make\s+(?:an?\s+)?intro|do\s+(?:an?\s+)?intro)\b/i,
  // "bring them together", "facilitate an introduction"
  /\b(?:facilitate|set up|setup)\b[\s\S]{0,30}\b(?:intro|introduction)\b/i,
]

export type IntroSignal = {
  matched: boolean
  // The substring that triggered the match — useful for UI display so the
  // user can see *why* AIEA flagged this commitment as an intro.
  reason: string | null
}

export function detectIntroIntent(text: string | null | undefined): IntroSignal {
  if (!text) return { matched: false, reason: null }
  for (const re of INTRO_PATTERNS) {
    const m = text.match(re)
    if (m) return { matched: true, reason: m[0] }
  }
  return { matched: false, reason: null }
}

// Deterministic hash for outbound_actions.event_hash. Combines the source
// contact ID, target contact ID, and channel so re-running detection on
// the same intro doesn't create duplicate drafts. Order-sensitive — an
// intro from A→B is a different action than B→A.
export function introEventHash(
  sourceContactId: string,
  targetContactId: string,
  channel: string,
): string {
  return `intro:${channel}:${sourceContactId}:${targetContactId}`
}
