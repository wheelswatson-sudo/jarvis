// Dev-only preview surface for the relationship score breakdown.
// Mounts RelationshipHealthBar in four representative states without
// requiring auth or live Supabase data — useful for visual review of the
// click-through breakdown UI. Returns 404 outside of `next dev`.

import { notFound } from 'next/navigation'
import { RelationshipHealthBar } from '../../../components/RelationshipHealth'
import type { Contact } from '../../../lib/types'

export const dynamic = 'force-static'

const NOW = '2026-05-09T19:30:00Z'

function fixture(
  partial: Partial<Contact> & { id: string; first_name: string },
): Contact {
  return {
    user_id: '00000000-0000-0000-0000-000000000000',
    last_name: null,
    email: null,
    phone: null,
    company: null,
    title: null,
    linkedin: null,
    tier: null,
    tags: null,
    ltv_estimate: null,
    half_life_days: null,
    sentiment_slope: null,
    sentiment_trajectory: null,
    reciprocity_ratio: null,
    metrics_computed_at: NOW,
    last_interaction_at: null,
    personal_details: null,
    relationship_score: null,
    relationship_score_components: null,
    next_follow_up: null,
    pipeline_stage: null,
    pipeline_notes: null,
    pipeline_updated_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...partial,
  }
}

const SAMPLES: { title: string; subtitle: string; contact: Contact }[] = [
  {
    title: 'Strong, fully populated',
    subtitle: 'All four signals present, score 84%',
    contact: fixture({
      id: '1',
      first_name: 'Strong',
      relationship_score: 0.84,
      relationship_score_components: {
        recency: 0.92,
        frequency: 0.78,
        sentiment: 0.81,
        follow_through: 0.88,
        computed_at: NOW,
      },
    }),
  },
  {
    title: 'Cooling, weak recency',
    subtitle: 'Surface the "send a check-in" hint',
    contact: fixture({
      id: '2',
      first_name: 'Cooling',
      relationship_score: 0.41,
      relationship_score_components: {
        recency: 0.18,
        frequency: 0.45,
        sentiment: 0.55,
        follow_through: 0.5,
        computed_at: NOW,
      },
    }),
  },
  {
    title: 'Cold, missing components',
    subtitle: 'Only two signals available — sentiment + follow-through omitted',
    contact: fixture({
      id: '3',
      first_name: 'Sparse',
      relationship_score: 0.12,
      relationship_score_components: {
        recency: 0.04,
        frequency: 0.21,
        computed_at: NOW,
      },
    }),
  },
  {
    title: 'Unscored (compute hasn’t run)',
    subtitle: 'Falls back to single-bar view, no expand',
    contact: fixture({
      id: '4',
      first_name: 'New',
      relationship_score: null,
      relationship_score_components: null,
    }),
  },
]

export default function ScorePreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-2xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Relationship score breakdown
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Static fixtures for visual review. Click each bar to expand.
          </p>
        </header>
        {SAMPLES.map((s) => (
          <section
            key={s.contact.id}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-5"
          >
            <h2 className="text-sm font-medium text-zinc-100">{s.title}</h2>
            <p className="mb-4 text-xs text-zinc-500">{s.subtitle}</p>
            <RelationshipHealthBar
              contact={s.contact}
              interactions={[]}
              commitments={[]}
            />
          </section>
        ))}
      </div>
    </main>
  )
}
