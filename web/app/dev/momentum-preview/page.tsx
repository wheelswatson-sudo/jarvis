// Dev-only preview for the contact-page momentum sparkline.
// Covers four states: rising, falling, flat, and "not enough history yet."

import { notFound } from 'next/navigation'
import { RelationshipMomentum } from '../../../components/RelationshipMomentum'
import type { ContactMomentum } from '../../../lib/intelligence/contact-momentum'

function makeSeries(values: (number | null)[]): ContactMomentum['series'] {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  return values.map((v, i) => ({
    computed_at: new Date(now - (values.length - 1 - i) * dayMs).toISOString(),
    composite: v,
    sentiment: v,
  }))
}

const RISING: ContactMomentum = {
  series: makeSeries([0.42, 0.45, 0.48, 0.5, 0.55, 0.6, 0.65, 0.7, 0.72, 0.78]),
  delta_30d: 0.31,
  sample_count: 10,
  current_composite: 0.78,
  current_sentiment: 0.72,
}

const FALLING: ContactMomentum = {
  series: makeSeries([0.78, 0.72, 0.68, 0.6, 0.55, 0.5, 0.46, 0.42, 0.4, 0.38]),
  delta_30d: -0.4,
  sample_count: 10,
  current_composite: 0.38,
  current_sentiment: 0.42,
}

const FLAT: ContactMomentum = {
  series: makeSeries([0.55, 0.54, 0.56, 0.55, 0.54, 0.55, 0.56, 0.55, 0.54, 0.55]),
  delta_30d: 0,
  sample_count: 10,
  current_composite: 0.55,
  current_sentiment: 0.55,
}

const SPARSE: ContactMomentum = {
  series: makeSeries([0.5]),
  delta_30d: null,
  sample_count: 1,
  current_composite: 0.5,
  current_sentiment: 0.5,
}

const EMPTY: ContactMomentum = {
  series: [],
  delta_30d: null,
  sample_count: 0,
  current_composite: null,
  current_sentiment: null,
}

export default function MomentumPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Momentum sparkline
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Rising / falling / flat / sparse / empty — each variant should
            pick the right accent color and copy.
          </p>
        </header>
        <Variant label="Rising 30d">
          <RelationshipMomentum momentum={RISING} />
        </Variant>
        <Variant label="Falling 30d">
          <RelationshipMomentum momentum={FALLING} />
        </Variant>
        <Variant label="Flat / no change">
          <RelationshipMomentum momentum={FLAT} />
        </Variant>
        <Variant label="Sparse (1 snapshot)">
          <RelationshipMomentum momentum={SPARSE} />
        </Variant>
        <Variant label="Empty (no history)">
          <RelationshipMomentum momentum={EMPTY} />
        </Variant>
      </div>
    </main>
  )
}

function Variant({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </div>
      {children}
    </div>
  )
}
