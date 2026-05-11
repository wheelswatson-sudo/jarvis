// ---------------------------------------------------------------------------
// loadContactMomentum — per-contact relationship-score time series for the
// momentum sparkline on /contacts/[id].
//
// Reads up to MAX_DAYS of snapshots, returns the chronological series (so
// the renderer can plot left-to-right oldest-to-newest) plus a 30-day
// delta. The page passes this directly to <RelationshipMomentum/>.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js'

const MAX_DAYS = 90
const DELTA_WINDOW_DAYS = 30

export type MomentumPoint = {
  computed_at: string
  composite: number | null
  sentiment: number | null
}

export type ContactMomentum = {
  series: MomentumPoint[]
  // Headline delta vs ~30 days ago, signed (positive = warming). NULL if
  // not enough history to compute.
  delta_30d: number | null
  // Snapshot count actually retrieved — useful for "not enough history"
  // empty-state copy.
  sample_count: number
  // Latest composite + sentiment for the at-a-glance line. NULL when no
  // snapshots exist at all.
  current_composite: number | null
  current_sentiment: number | null
}

type SnapshotRow = {
  composite: number | string | null
  sentiment: number | string | null
  computed_at: string
}

export async function loadContactMomentum(
  service: SupabaseClient,
  userId: string,
  contactId: string,
  opts?: { now?: Date },
): Promise<ContactMomentum> {
  const now = opts?.now ?? new Date()
  const lookbackIso = new Date(
    now.getTime() - MAX_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data, error } = await service
    .from('relationship_score_snapshots')
    .select('composite, sentiment, computed_at')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .gte('computed_at', lookbackIso)
    .order('computed_at', { ascending: true })
    .limit(200)

  if (error) {
    return emptyMomentum()
  }

  const rows = (data ?? []) as SnapshotRow[]
  const series: MomentumPoint[] = rows.map((r) => ({
    computed_at: r.computed_at,
    composite: numericOrNull(r.composite),
    sentiment: numericOrNull(r.sentiment),
  }))

  if (series.length === 0) return emptyMomentum()

  const latest = series[series.length - 1]!
  const currentComposite = latest.composite
  const currentSentiment = latest.sentiment

  // Headline delta: latest composite vs the snapshot closest to
  // now - 30d. If the closest is <14 days away from the target, skip
  // (signal too noisy) — same tolerance philosophy as sentiment-shifts.
  let delta30d: number | null = null
  if (currentComposite != null) {
    const target = now.getTime() - DELTA_WINDOW_DAYS * 24 * 60 * 60 * 1000
    let best: { dist: number; point: MomentumPoint } | null = null
    for (const p of series) {
      if (p === latest) continue
      const ts = new Date(p.computed_at).getTime()
      if (!Number.isFinite(ts)) continue
      const dist = Math.abs(ts - target)
      if (!best || dist < best.dist) best = { dist, point: p }
    }
    if (best && best.dist <= 14 * 24 * 60 * 60 * 1000) {
      if (best.point.composite != null) {
        delta30d = currentComposite - best.point.composite
      }
    }
  }

  return {
    series,
    delta_30d: delta30d,
    sample_count: series.length,
    current_composite: currentComposite,
    current_sentiment: currentSentiment,
  }
}

function emptyMomentum(): ContactMomentum {
  return {
    series: [],
    delta_30d: null,
    sample_count: 0,
    current_composite: null,
    current_sentiment: null,
  }
}

function numericOrNull(n: number | string | null | undefined): number | null {
  if (n == null) return null
  const v = typeof n === 'string' ? Number(n) : n
  if (!Number.isFinite(v)) return null
  return v
}
