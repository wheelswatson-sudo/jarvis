// Dev-only preview for the RecentLifeEvents surface.
import { notFound } from 'next/navigation'
import { RecentLifeEvents } from '../../../components/RecentLifeEvents'
import type { RecentLifeEvent } from '../../../lib/intelligence/recent-life-events'

const EVENTS: RecentLifeEvent[] = [
  {
    id: 'le:c1:today:abc',
    contact_id: 'c1',
    contact_name: 'Kris Cravens',
    event: 'Promoted to VP Operations',
    date: '2026-05-11',
    days_ago: 0,
    tier: 1,
    relationship_score: 0.78,
  },
  {
    id: 'le:c2:yest:def',
    contact_id: 'c2',
    contact_name: 'Sarah Chen',
    event: 'Welcomed second daughter',
    date: '2026-05-10',
    days_ago: 1,
    tier: 2,
    relationship_score: 0.55,
  },
  {
    id: 'le:c3:5d:ghi',
    contact_id: 'c3',
    contact_name: 'Mark Jensen',
    event: 'Closed seed round',
    date: '2026-05-06',
    days_ago: 5,
    tier: 2,
    relationship_score: 0.71,
  },
  {
    id: 'le:c4:12d:jkl',
    contact_id: 'c4',
    contact_name: 'Jamie Russo',
    event: 'Moved to Austin',
    date: '2026-04-29',
    days_ago: 12,
    tier: 3,
    relationship_score: 0.42,
  },
]

export default function LifeEventsPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Recent life events
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Today / yesterday / 5d / 12d. Mix of promotion, family, business,
            and life-move events.
          </p>
        </header>
        <RecentLifeEvents events={EVENTS} />
      </div>
    </main>
  )
}
