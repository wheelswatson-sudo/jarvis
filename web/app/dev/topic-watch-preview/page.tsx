// Dev-only preview for the TopicWatch surface.
import { notFound } from 'next/navigation'
import { TopicWatch } from '../../../components/TopicWatch'
import type { TopicWatchHit } from '../../../lib/intelligence/topic-watch'

const HITS: TopicWatchHit[] = [
  {
    id: 'topic:m1:fundraising',
    contact_id: 'c1',
    contact_name: 'Sarah Chen',
    topic: 'fundraising',
    message_id: 'm1',
    direction: 'inbound',
    subject: 'Re: investor intro — fundraising timing question',
    snippet: 'Was hoping to talk through the timeline for our next raise…',
    sent_at: '2026-05-11T10:00:00Z',
    days_ago: 0,
    tier: 2,
    relationship_score: 0.62,
    href: '/contacts/c1',
  },
  {
    id: 'topic:m2:hiring',
    contact_id: 'c2',
    contact_name: 'Mark Jensen',
    topic: 'hiring',
    message_id: 'm2',
    direction: 'inbound',
    subject: 'CTO search update',
    snippet: 'We narrowed it down to two finalists for the hiring decision…',
    sent_at: '2026-05-09T14:00:00Z',
    days_ago: 2,
    tier: 1,
    relationship_score: 0.78,
    href: '/contacts/c2',
  },
  {
    id: 'topic:m3:office-space',
    contact_id: 'c3',
    contact_name: 'Devon Park',
    topic: 'office space',
    message_id: 'm3',
    direction: 'outbound',
    subject: 'Re: the SoMa lease question',
    snippet: 'Yeah — we toured two more office spaces yesterday…',
    sent_at: '2026-05-06T18:00:00Z',
    days_ago: 5,
    tier: 3,
    relationship_score: 0.42,
    href: '/contacts/c3',
  },
]

export default function TopicWatchPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Topic watch
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Three fixtures: inbound message mentioning a tracked topic, plus
            an outbound case (the user themselves brought it up).
          </p>
        </header>
        <TopicWatch hits={HITS} />
      </div>
    </main>
  )
}
