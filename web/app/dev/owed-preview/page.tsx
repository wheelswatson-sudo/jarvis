// Dev-only preview for the OwedToYou surface.
import { notFound } from 'next/navigation'
import { OwedToYou } from '../../../components/OwedToYou'
import type { OwedToYou as OwedItem } from '../../../lib/intelligence/owed-to-you'

const ITEMS: OwedItem[] = [
  {
    id: 'owed:1',
    contact_id: 'c1',
    contact_name: 'Sarah Chen',
    description: 'Send signed MSA back to legal',
    due_at: '2026-04-25T17:00:00Z',
    days_relative: -16,
    severity: 'critical',
    hint: 'Sarah Chen owes you "Send signed MSA back to legal" — 16d overdue.',
    href: '/contacts/c1',
    relationship_score: 0.68,
  },
  {
    id: 'owed:2',
    contact_id: 'c2',
    contact_name: 'Mark Jensen',
    description: 'Intro to your CRO',
    due_at: '2026-05-04T17:00:00Z',
    days_relative: -7,
    severity: 'high',
    hint: 'Mark Jensen owes you "Intro to your CRO" — 7d overdue.',
    href: '/contacts/c2',
    relationship_score: 0.55,
  },
  {
    id: 'owed:3',
    contact_id: 'c3',
    contact_name: 'Devon Park',
    description: 'Quote on the rebrand work',
    due_at: '2026-05-13T17:00:00Z',
    days_relative: 2,
    severity: 'medium',
    hint: 'Devon Park owes you "Quote on the rebrand work" — due in 2d.',
    href: '/contacts/c3',
    relationship_score: 0.42,
  },
]

export default function OwedPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Owed to you
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Three fixtures: critical (16d overdue), high (7d overdue),
            medium (due in 2d).
          </p>
        </header>
        <OwedToYou items={ITEMS} />
      </div>
    </main>
  )
}
