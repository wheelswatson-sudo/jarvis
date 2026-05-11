// ---------------------------------------------------------------------------
// findUpcomingMilestones — "the assistant who never forgets a birthday."
//
// Reads contacts' personal_details for birthdays + key_milestones, finds the
// next annual occurrence of each (month-day match), and returns anything
// within MILESTONE_LOOKAHEAD_DAYS. Two sources are merged because Google
// sync writes `birthdays` (plural array) while manual edits write
// `birthday` (singular string) — both legal, both surfaced.
//
// Pure read of existing personal_details — no migration, no LLM. The signal
// degrades gracefully: contacts with no milestone data simply contribute
// nothing.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PersonalDetails } from '../types'

// Tunables. Watson — extend MILESTONE_LOOKAHEAD_DAYS if you want a wider
// radar; tighten if the list gets noisy.
const MILESTONE_LOOKAHEAD_DAYS = 14
const MAX_ITEMS = 8
const MIN_TIER_OR_SCORE = 0.2 // dedupe-noise floor; T1/T2 always passes

export type MilestoneKind = 'birthday' | 'milestone'

export type UpcomingMilestone = {
  id: string
  contact_id: string
  contact_name: string
  kind: MilestoneKind
  label: string
  // Days until the next occurrence (0 = today, negative never returned).
  days_until: number
  // Next occurrence ISO date (YYYY-MM-DD).
  next_date: string
  // Best-effort year-of-event, if known. Drives "X turns 30" / "Y years"
  // copy in the renderer.
  original_year: number | null
  tier: number | null
  relationship_score: number | null
}

type ContactRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  tier: number | null
  relationship_score: number | null
  personal_details: (PersonalDetails & { birthdays?: string[] | null }) | null
}

export async function findUpcomingMilestones(
  service: SupabaseClient,
  userId: string,
  opts?: { lookaheadDays?: number; now?: Date },
): Promise<UpcomingMilestone[]> {
  const now = opts?.now ?? new Date()
  const lookahead = opts?.lookaheadDays ?? MILESTONE_LOOKAHEAD_DAYS

  const { data, error } = await service
    .from('contacts')
    .select(
      'id, first_name, last_name, email, tier, relationship_score, personal_details',
    )
    .eq('user_id', userId)
    .limit(5000)

  if (error) return []
  const contacts = (data ?? []) as ContactRow[]

  const items: UpcomingMilestone[] = []
  for (const c of contacts) {
    const pd = c.personal_details ?? null
    if (!pd) continue
    if (!passesFloor(c)) continue
    const name = nameOf(c)

    const birthdayStrings = collectBirthdayStrings(pd)
    for (const raw of birthdayStrings) {
      const parsed = parseMonthDay(raw)
      if (!parsed) continue
      const nextDate = nextOccurrence(parsed.month, parsed.day, now)
      const daysUntil = daysBetweenDates(now, nextDate)
      if (daysUntil < 0 || daysUntil > lookahead) continue
      items.push({
        id: `bday:${c.id}:${parsed.month}-${parsed.day}`,
        contact_id: c.id,
        contact_name: name,
        kind: 'birthday',
        label: 'Birthday',
        days_until: daysUntil,
        next_date: formatIsoDate(nextDate),
        original_year: parsed.year,
        tier: c.tier,
        relationship_score: c.relationship_score,
      })
    }

    const keyMilestones = pd.key_milestones ?? []
    for (const km of keyMilestones) {
      if (!km?.date) continue
      const parsed = parseMonthDay(km.date)
      if (!parsed) continue
      const nextDate = nextOccurrence(parsed.month, parsed.day, now)
      const daysUntil = daysBetweenDates(now, nextDate)
      if (daysUntil < 0 || daysUntil > lookahead) continue
      items.push({
        id: `ms:${c.id}:${parsed.month}-${parsed.day}:${shortHash(km.event)}`,
        contact_id: c.id,
        contact_name: name,
        kind: 'milestone',
        label: km.event,
        days_until: daysUntil,
        next_date: formatIsoDate(nextDate),
        original_year: parsed.year,
        tier: c.tier,
        relationship_score: c.relationship_score,
      })
    }
  }

  // Dedupe by id (a contact can have multiple distinct milestones, but the
  // same milestone shouldn't appear twice — id already encodes contact +
  // kind + date + event).
  const seen = new Set<string>()
  const deduped: UpcomingMilestone[] = []
  for (const it of items) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    deduped.push(it)
  }

  return deduped
    .sort((a, b) => {
      // Soonest first; tier breaks ties (lower tier = closer relationship);
      // then alphabetic by name for stability.
      if (a.days_until !== b.days_until) return a.days_until - b.days_until
      const at = a.tier ?? 99
      const bt = b.tier ?? 99
      if (at !== bt) return at - bt
      return a.contact_name.localeCompare(b.contact_name)
    })
    .slice(0, MAX_ITEMS)
}

// ---------------------------------------------------------------------------
// Helpers — exported for testing
// ---------------------------------------------------------------------------

export function parseMonthDay(
  raw: string,
): { month: number; day: number; year: number | null } | null {
  if (!raw) return null
  const trimmed = raw.trim()

  // Try YYYY-MM-DD
  const fullMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (fullMatch) {
    const year = Number(fullMatch[1])
    const month = Number(fullMatch[2])
    const day = Number(fullMatch[3])
    if (isValidMonthDay(month, day))
      return { month, day, year: Number.isFinite(year) ? year : null }
  }

  // Try MM-DD or MM/DD (no year)
  const mdMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})$/)
  if (mdMatch) {
    const month = Number(mdMatch[1])
    const day = Number(mdMatch[2])
    if (isValidMonthDay(month, day)) return { month, day, year: null }
  }

  // Try ISO with time component (YYYY-MM-DDTHH:mm…)
  const isoTs = new Date(trimmed)
  if (!Number.isNaN(isoTs.getTime())) {
    const month = isoTs.getUTCMonth() + 1
    const day = isoTs.getUTCDate()
    const year = isoTs.getUTCFullYear()
    if (isValidMonthDay(month, day)) return { month, day, year }
  }

  return null
}

export function nextOccurrence(
  month: number,
  day: number,
  now: Date,
): Date {
  // Use UTC throughout to avoid TZ drift; we only care about month-day.
  const year = now.getUTCFullYear()
  const candidate = new Date(Date.UTC(year, month - 1, day))
  // If today is the date, return today (zero days_until); only roll over
  // if the candidate is strictly before today (UTC date).
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  if (candidate.getTime() < today.getTime()) {
    return new Date(Date.UTC(year + 1, month - 1, day))
  }
  return candidate
}

function passesFloor(c: ContactRow): boolean {
  if (c.tier === 1 || c.tier === 2) return true
  if (c.relationship_score == null) return true // never-computed allowed
  return c.relationship_score >= MIN_TIER_OR_SCORE
}

function collectBirthdayStrings(
  pd: PersonalDetails & { birthdays?: string[] | null },
): string[] {
  const out: string[] = []
  if (pd.birthday) out.push(pd.birthday)
  if (Array.isArray(pd.birthdays)) {
    for (const b of pd.birthdays) {
      if (typeof b === 'string' && b.length > 0) out.push(b)
    }
  }
  return out
}

function isValidMonthDay(month: number, day: number): boolean {
  if (!Number.isFinite(month) || !Number.isFinite(day)) return false
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  // Crude calendar check — month-specific day max. Good enough for
  // birthday parsing.
  const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  return day <= maxDays
}

function daysBetweenDates(now: Date, target: Date): number {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  const tgt = Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
  )
  return Math.round((tgt - today) / (24 * 60 * 60 * 1000))
}

function formatIsoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function nameOf(c: ContactRow): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.join(' ').trim()
  return c.email ?? 'Unknown contact'
}

// Small deterministic hash for milestone-event labels — keeps the id stable
// across reads, so React keys don't flicker.
function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36).slice(0, 6)
}
