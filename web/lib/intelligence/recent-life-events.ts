// ---------------------------------------------------------------------------
// findRecentLifeEvents — "something big just happened to this person."
//
// Reads `personal_details.life_events` (an array of { date?, event }) and
// surfaces any event whose date falls within the last LOOKBACK_DAYS. Used
// to prompt the user to acknowledge — congrats on a promotion, condolences
// on a loss, hello-to-the-new-baby. The EA move is timing: bringing it up
// in the week it happened, not three months later.
//
// Pure read of existing personal_details — no migration, no LLM.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PersonalDetails } from '../types'

const LOOKBACK_DAYS = 14
const MAX_ITEMS = 6
const MIN_RELATIONSHIP_SCORE = 0.2

export type RecentLifeEvent = {
  id: string
  contact_id: string
  contact_name: string
  event: string
  date: string // YYYY-MM-DD
  days_ago: number
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
  personal_details: PersonalDetails | null
}

export async function findRecentLifeEvents(
  service: SupabaseClient,
  userId: string,
  opts?: { lookbackDays?: number; now?: Date },
): Promise<RecentLifeEvent[]> {
  const now = opts?.now ?? new Date()
  const lookback = opts?.lookbackDays ?? LOOKBACK_DAYS

  const { data, error } = await service
    .from('contacts')
    .select(
      'id, first_name, last_name, email, tier, relationship_score, personal_details',
    )
    .eq('user_id', userId)
    .limit(5000)

  if (error) return []
  const contacts = (data ?? []) as ContactRow[]

  const items: RecentLifeEvent[] = []
  for (const c of contacts) {
    const pd = c.personal_details
    if (!pd) continue
    if (!passesFloor(c)) continue
    const life = pd.life_events ?? []
    if (life.length === 0) continue

    const name = nameOf(c)
    for (const le of life) {
      if (!le?.event || !le?.date) continue
      const eventDate = parseDate(le.date)
      if (!eventDate) continue
      const daysAgo = daysBetween(eventDate, now)
      if (daysAgo < 0 || daysAgo > lookback) continue
      items.push({
        id: `le:${c.id}:${le.date}:${shortHash(le.event)}`,
        contact_id: c.id,
        contact_name: name,
        event: le.event,
        date: formatIsoDate(eventDate),
        days_ago: daysAgo,
        tier: c.tier,
        relationship_score: c.relationship_score,
      })
    }
  }

  // Sort most-recent first; tier breaks ties.
  return items
    .sort((a, b) => {
      if (a.days_ago !== b.days_ago) return a.days_ago - b.days_ago
      const at = a.tier ?? 99
      const bt = b.tier ?? 99
      return at - bt
    })
    .slice(0, MAX_ITEMS)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function passesFloor(c: ContactRow): boolean {
  if (c.tier === 1 || c.tier === 2) return true
  if (c.relationship_score == null) return true
  return c.relationship_score >= MIN_RELATIONSHIP_SCORE
}

function parseDate(raw: string): Date | null {
  if (!raw) return null
  const trimmed = raw.trim()
  // YYYY-MM-DD / YYYY/MM/DD
  const ymd = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (ymd) {
    const y = Number(ymd[1])
    const m = Number(ymd[2])
    const d = Number(ymd[3])
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return new Date(Date.UTC(y, m - 1, d))
    }
  }
  // Fallback to Date constructor
  const fallback = new Date(trimmed)
  if (!Number.isNaN(fallback.getTime())) {
    return new Date(
      Date.UTC(
        fallback.getUTCFullYear(),
        fallback.getUTCMonth(),
        fallback.getUTCDate(),
      ),
    )
  }
  return null
}

function daysBetween(eventDate: Date, now: Date): number {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  const ev = eventDate.getTime()
  return Math.round((today - ev) / (24 * 60 * 60 * 1000))
}

function formatIsoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function nameOf(c: ContactRow): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.join(' ').trim()
  return c.email ?? 'Unknown contact'
}

function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36).slice(0, 6)
}
