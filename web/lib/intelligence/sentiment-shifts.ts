// ---------------------------------------------------------------------------
// findSentimentShifts — "the tone changed with [Name]" surface.
//
// Reads the `relationship_score_snapshots` history table, picks each
// contact's *current* and *prior* snapshot ~SHIFT_WINDOW_DAYS apart, and
// detects shifts above threshold.
//
// Two detection modes (per-contact, first match wins):
//
//   1. SENTIMENT shift — |Δsentiment| >= SENTIMENT_DELTA_THRESHOLD when
//      sentiment data exists on BOTH endpoints. This is the headline signal
//      the user explicitly asked for: tone changed.
//
//   2. COMPOSITE shift (fallback) — sentiment is null on one endpoint (no
//      Gmail extraction history for that span). Detect a meaningful
//      composite drop, since composite already incorporates recency +
//      frequency. Threshold tighter (COMPOSITE_DROP_THRESHOLD) because
//      composite is the more aggregated signal.
//
// Severity is the magnitude of the shift weighted by the contact's current
// relationship_score — a cooling on a T1 contact outranks a cooling on a
// stranger. Items capped at MAX_ITEMS; one shift per contact (cooling and
// warming are mutually exclusive by definition).
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'

// Tunable thresholds. Watson — these are the EA-judgment dials.
//   SHIFT_WINDOW_DAYS         how far back to compare against (longer = slower trend)
//   SHIFT_WINDOW_TOLERANCE    half-window of slack so a missed cron day still pairs up
//   SENTIMENT_DELTA_THRESHOLD min |Δsentiment| to count as a shift (0-1 scale)
//   COMPOSITE_DROP_THRESHOLD  composite drop magnitude when sentiment is null
//   MIN_RELATIONSHIP_SCORE    score floor to skip wider-network noise
const SHIFT_WINDOW_DAYS = 14
const SHIFT_WINDOW_TOLERANCE_DAYS = 5
const SNAPSHOT_LOOKBACK_DAYS = SHIFT_WINDOW_DAYS + SHIFT_WINDOW_TOLERANCE_DAYS + 2
const SENTIMENT_DELTA_THRESHOLD = 0.2
const COMPOSITE_DROP_THRESHOLD = 0.15
const MIN_RELATIONSHIP_SCORE = 0.2
const MAX_ITEMS = 8
const SNAPSHOT_QUERY_LIMIT = 50000

export type SentimentDirection = 'cooled' | 'warmed'
export type SentimentShiftSource = 'sentiment' | 'composite'

export type SentimentShift = {
  id: string
  contact_id: string
  contact_name: string
  direction: SentimentDirection
  source: SentimentShiftSource
  // Magnitude of the shift on the 0-1 score scale (absolute value).
  delta: number
  // Endpoints in the same units we delta'd on (0-1).
  current: number
  prior: number
  days_between: number
  severity: 'critical' | 'high' | 'medium'
  hint: string
  href: string
  relationship_score: number | null
}

type SnapshotRow = {
  contact_id: string
  composite: number | string | null
  sentiment: number | string | null
  computed_at: string
}

type ContactRow = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  relationship_score: number | null
  tier: number | null
}

export async function findSentimentShifts(
  service: SupabaseClient,
  userId: string,
): Promise<SentimentShift[]> {
  const now = Date.now()
  const lookbackIso = new Date(
    now - SNAPSHOT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const [snapshotsRes, contactsRes] = await Promise.all([
    service
      .from('relationship_score_snapshots')
      .select('contact_id, composite, sentiment, computed_at')
      .eq('user_id', userId)
      .gte('computed_at', lookbackIso)
      .order('computed_at', { ascending: false })
      .limit(SNAPSHOT_QUERY_LIMIT),
    service
      .from('contacts')
      .select('id, first_name, last_name, email, relationship_score, tier')
      .eq('user_id', userId)
      .limit(5000),
  ])

  const snapshots = (snapshotsRes.data ?? []) as SnapshotRow[]
  const contacts = (contactsRes.data ?? []) as ContactRow[]
  const contactsById = new Map<string, ContactRow>()
  for (const c of contacts) contactsById.set(c.id, c)

  // Group snapshots by contact, retaining newest-first order from the
  // query. For each contact we only ever read the head + one prior — so we
  // could short-circuit, but the group pass also gives us count for the
  // "needs at least two snapshots" filter.
  const byContact = new Map<string, SnapshotRow[]>()
  for (const s of snapshots) {
    if (!s.contact_id) continue
    const list = byContact.get(s.contact_id)
    if (list) list.push(s)
    else byContact.set(s.contact_id, [s])
  }

  const shifts: SentimentShift[] = []

  for (const [contactId, rows] of byContact) {
    if (rows.length < 2) continue
    const contact = contactsById.get(contactId)
    if (!contact) continue
    if (!passesScoreFloor(contact)) continue

    const latest = rows[0]!
    const prior = pickPriorSnapshot(rows, latest, now)
    if (!prior) continue

    const detection = detectShift(latest, prior)
    if (!detection) continue

    const daysBetween = daysBetweenIso(prior.computed_at, latest.computed_at)
    const name = nameOf(contact)
    const direction: SentimentDirection =
      detection.deltaSigned < 0 ? 'cooled' : 'warmed'
    const severity = severityFromDeltaAndScore(
      detection.delta,
      contact.relationship_score,
    )

    shifts.push({
      id: `shift:${contactId}:${latest.computed_at}`,
      contact_id: contactId,
      contact_name: name,
      direction,
      source: detection.source,
      delta: round4(detection.delta),
      current: round4(detection.current),
      prior: round4(detection.prior),
      days_between: daysBetween,
      severity,
      hint: buildHint(
        name,
        direction,
        detection.source,
        detection.current,
        detection.prior,
        daysBetween,
      ),
      href: `/contacts/${contactId}`,
      relationship_score: contact.relationship_score,
    })
  }

  return shifts
    .sort((a, b) => severityRank(b) - severityRank(a))
    .slice(0, MAX_ITEMS)
}

// ---------------------------------------------------------------------------
// Detection — exported for unit testing
// ---------------------------------------------------------------------------

type Detection = {
  source: SentimentShiftSource
  // Signed delta in the underlying 0-1 scale (positive = warmed).
  deltaSigned: number
  delta: number
  current: number
  prior: number
}

export function detectShift(
  latest: Pick<SnapshotRow, 'composite' | 'sentiment'>,
  prior: Pick<SnapshotRow, 'composite' | 'sentiment'>,
): Detection | null {
  const sLatest = numericOrNull(latest.sentiment)
  const sPrior = numericOrNull(prior.sentiment)
  if (sLatest != null && sPrior != null) {
    const deltaSigned = sLatest - sPrior
    if (Math.abs(deltaSigned) >= SENTIMENT_DELTA_THRESHOLD) {
      return {
        source: 'sentiment',
        deltaSigned,
        delta: Math.abs(deltaSigned),
        current: sLatest,
        prior: sPrior,
      }
    }
  }

  // Fallback — sentiment was null on at least one endpoint. Detect a
  // meaningful composite drop (not a rise — composite rises commonly from
  // a single fresh email and aren't alert-worthy).
  const cLatest = numericOrNull(latest.composite)
  const cPrior = numericOrNull(prior.composite)
  if (cLatest != null && cPrior != null) {
    const deltaSigned = cLatest - cPrior
    if (deltaSigned <= -COMPOSITE_DROP_THRESHOLD) {
      return {
        source: 'composite',
        deltaSigned,
        delta: Math.abs(deltaSigned),
        current: cLatest,
        prior: cPrior,
      }
    }
  }

  return null
}

// Pick the snapshot closest to `latest - SHIFT_WINDOW_DAYS`, within the
// tolerance band. Walks the (already newest-first) row list — typical
// contact has a handful of snapshots, so linear scan is fine.
export function pickPriorSnapshot(
  rows: SnapshotRow[],
  latest: SnapshotRow,
  now: number,
): SnapshotRow | null {
  const latestTs = new Date(latest.computed_at).getTime()
  if (!Number.isFinite(latestTs)) return null
  const targetTs = latestTs - SHIFT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const minTs = targetTs - SHIFT_WINDOW_TOLERANCE_DAYS * 24 * 60 * 60 * 1000
  const maxTs = targetTs + SHIFT_WINDOW_TOLERANCE_DAYS * 24 * 60 * 60 * 1000

  let best: { row: SnapshotRow; dist: number } | null = null
  for (const r of rows) {
    if (r === latest) continue
    const ts = new Date(r.computed_at).getTime()
    if (!Number.isFinite(ts)) continue
    if (ts < minTs || ts > maxTs) continue
    const dist = Math.abs(ts - targetTs)
    if (!best || dist < best.dist) best = { row: r, dist }
  }
  // Suppress unused-var lint without changing the signature — callers may
  // want to pass `now` in the future for stricter window logic.
  void now
  return best?.row ?? null
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function passesScoreFloor(contact: ContactRow): boolean {
  if (contact.tier === 1 || contact.tier === 2) return true
  if (contact.relationship_score == null) return false
  return contact.relationship_score >= MIN_RELATIONSHIP_SCORE
}

function severityFromDeltaAndScore(
  delta: number,
  score: number | null,
): 'critical' | 'high' | 'medium' {
  const s = score ?? 0
  // delta is 0-1; score is 0-1. Heat range typically 0.2 – 0.8.
  const heat = delta + s * 0.6
  if (heat >= 0.6) return 'critical'
  if (heat >= 0.4) return 'high'
  return 'medium'
}

function severityRank(shift: SentimentShift): number {
  const sev =
    shift.severity === 'critical' ? 100 : shift.severity === 'high' ? 50 : 0
  // Cooled shifts outrank warmed at the same severity — a relationship
  // sliding is more actionable than one improving.
  const directionBonus = shift.direction === 'cooled' ? 5 : 0
  // Sentiment-source shifts outrank composite-fallback at the same
  // severity — sentiment is the named signal.
  const sourceBonus = shift.source === 'sentiment' ? 3 : 0
  return (
    sev +
    directionBonus +
    sourceBonus +
    shift.delta * 100 +
    (shift.relationship_score ?? 0) * 30
  )
}

function buildHint(
  name: string,
  direction: SentimentDirection,
  source: SentimentShiftSource,
  current: number,
  prior: number,
  days: number,
): string {
  const verb = direction === 'cooled' ? 'cooled' : 'warmed'
  const currentPct = Math.round(current * 100)
  const priorPct = Math.round(prior * 100)
  const label = source === 'sentiment' ? 'Tone with' : 'Relationship with'
  return `${label} ${name} ${verb} — ${priorPct}% → ${currentPct}% over ${days}d.`
}

function nameOf(c: ContactRow): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) return parts.join(' ').trim()
  return c.email ?? 'Unknown contact'
}

function numericOrNull(n: number | string | null | undefined): number | null {
  if (n == null) return null
  const v = typeof n === 'string' ? Number(n) : n
  if (!Number.isFinite(v)) return null
  return v
}

function daysBetweenIso(aIso: string, bIso: string): number {
  const a = new Date(aIso).getTime()
  const b = new Date(bIso).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.max(0, Math.round(Math.abs(b - a) / (24 * 60 * 60 * 1000)))
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Number(n.toFixed(4))
}
