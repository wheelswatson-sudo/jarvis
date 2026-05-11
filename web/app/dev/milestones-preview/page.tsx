// Dev-only preview surface for the MilestoneRadar UI.
// Covers today / tomorrow / N-days-out, birthday and milestone kinds,
// and the age-hint variants ("Turns 40" vs "10 years").

import { notFound } from 'next/navigation'
import { MilestoneRadar } from '../../../components/MilestoneRadar'
import type { UpcomingMilestone } from '../../../lib/intelligence/milestone-radar'

const TODAY = '2026-05-11'
const TOMORROW = '2026-05-12'
const IN_3D = '2026-05-14'
const IN_8D = '2026-05-19'
const IN_14D = '2026-05-25'

const MILESTONES: UpcomingMilestone[] = [
  {
    id: 'bday:c-kris:5-11',
    contact_id: 'c-kris',
    contact_name: 'Kris Cravens',
    kind: 'birthday',
    label: 'Birthday',
    days_until: 0,
    next_date: TODAY,
    original_year: 1986,
    tier: 1,
    relationship_score: 0.78,
  },
  {
    id: 'bday:c-mark:5-12',
    contact_id: 'c-mark',
    contact_name: 'Mark Jensen',
    kind: 'birthday',
    label: 'Birthday',
    days_until: 1,
    next_date: TOMORROW,
    original_year: 1979,
    tier: 2,
    relationship_score: 0.71,
  },
  {
    id: 'ms:c-sarah:5-14:abc123',
    contact_id: 'c-sarah',
    contact_name: 'Sarah Chen',
    kind: 'milestone',
    label: 'Work anniversary at Stripe',
    days_until: 3,
    next_date: IN_3D,
    original_year: 2018,
    tier: 2,
    relationship_score: 0.55,
  },
  {
    id: 'bday:c-jamie:5-19',
    contact_id: 'c-jamie',
    contact_name: 'Jamie Russo',
    kind: 'birthday',
    label: 'Birthday',
    days_until: 8,
    next_date: IN_8D,
    original_year: null,
    tier: 3,
    relationship_score: 0.42,
  },
  {
    id: 'ms:c-devon:5-25:def456',
    contact_id: 'c-devon',
    contact_name: 'Devon Park',
    kind: 'milestone',
    label: 'Wedding anniversary',
    days_until: 14,
    next_date: IN_14D,
    original_year: 2021,
    tier: 3,
    relationship_score: 0.34,
  },
]

export default function MilestonesPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Milestone radar
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Five fixtures: today/tomorrow/N-days, both kinds, with and without
            year-of-event for the age-hint variants.
          </p>
        </header>
        <MilestoneRadar milestones={MILESTONES} />
      </div>
    </main>
  )
}
