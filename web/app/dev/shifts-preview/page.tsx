// Dev-only preview surface for the SentimentShifts UI.
// Covers cooling/warming directions, sentiment vs composite sources, and
// all three severity tiers — including the visually subtle case of a
// medium-warming shift to confirm the emerald variant doesn't disappear.

import { notFound } from 'next/navigation'
import { SentimentShifts } from '../../../components/SentimentShifts'
import type { SentimentShift } from '../../../lib/intelligence/sentiment-shifts'

const SHIFTS: SentimentShift[] = [
  {
    id: 'shift:c1:2026-05-11',
    contact_id: 'c1',
    contact_name: 'Mark Jensen',
    direction: 'cooled',
    source: 'sentiment',
    delta: 0.31,
    current: 0.41,
    prior: 0.72,
    days_between: 14,
    severity: 'critical',
    hint: 'Tone with Mark Jensen cooled — 72% → 41% over 14d.',
    href: '/contacts/c1',
    relationship_score: 0.71,
  },
  {
    id: 'shift:c2:2026-05-11',
    contact_id: 'c2',
    contact_name: 'Sarah Chen',
    direction: 'cooled',
    source: 'sentiment',
    delta: 0.22,
    current: 0.46,
    prior: 0.68,
    days_between: 13,
    severity: 'high',
    hint: 'Tone with Sarah Chen cooled — 68% → 46% over 13d.',
    href: '/contacts/c2',
    relationship_score: 0.55,
  },
  {
    id: 'shift:c3:2026-05-11',
    contact_id: 'c3',
    contact_name: 'Devon Park',
    direction: 'cooled',
    source: 'composite',
    delta: 0.18,
    current: 0.34,
    prior: 0.52,
    days_between: 15,
    severity: 'medium',
    hint: 'Relationship with Devon Park cooled — 52% → 34% over 15d.',
    href: '/contacts/c3',
    relationship_score: 0.34,
  },
  {
    id: 'shift:c4:2026-05-11',
    contact_id: 'c4',
    contact_name: 'Kris Cravens',
    direction: 'warmed',
    source: 'sentiment',
    delta: 0.28,
    current: 0.81,
    prior: 0.53,
    days_between: 14,
    severity: 'high',
    hint: 'Tone with Kris Cravens warmed — 53% → 81% over 14d.',
    href: '/contacts/c4',
    relationship_score: 0.78,
  },
  {
    id: 'shift:c5:2026-05-11',
    contact_id: 'c5',
    contact_name: 'Jamie Russo',
    direction: 'warmed',
    source: 'sentiment',
    delta: 0.21,
    current: 0.72,
    prior: 0.51,
    days_between: 12,
    severity: 'medium',
    hint: 'Tone with Jamie Russo warmed — 51% → 72% over 12d.',
    href: '/contacts/c5',
    relationship_score: 0.42,
  },
]

export default function ShiftsPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Sentiment-shift alerts
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Five fixtures: critical/high/medium cooling, plus high & medium
            warming. Covers sentiment-source and composite-fallback paths.
          </p>
        </header>
        <SentimentShifts shifts={SHIFTS} />
      </div>
    </main>
  )
}
