// Dev-only preview for NewVoices.
import { notFound } from 'next/navigation'
import { NewVoices } from '../../../components/NewVoices'
import type { NewVoice } from '../../../lib/intelligence/new-voices'

const VOICES: NewVoice[] = [
  {
    id: 'nv:1:brand',
    contact_id: 'c1',
    contact_name: 'Priya Anand',
    kind: 'brand_new',
    message_id: 'm1',
    subject: 'Intro from Mark — exploring partnership',
    snippet: 'Hi Watson, Mark suggested I reach out…',
    sent_at: '2026-05-11T09:00:00Z',
    days_ago: 0,
    gap_days: null,
    tier: null,
    href: '/contacts/c1',
  },
  {
    id: 'nv:2:reemerge',
    contact_id: 'c2',
    contact_name: 'Jamie Russo',
    kind: 'reemerging',
    message_id: 'm2',
    subject: 'Back in town next week — coffee?',
    snippet: "It has been a while — I am flying through SF…",
    sent_at: '2026-05-10T15:30:00Z',
    days_ago: 1,
    gap_days: 187,
    tier: 3,
    href: '/contacts/c2',
  },
  {
    id: 'nv:3:reemerge',
    contact_id: 'c3',
    contact_name: 'Devon Park',
    kind: 'reemerging',
    message_id: 'm3',
    subject: 'Hey — long time, quick question',
    snippet: "Hope you're well. Wanted to ask about…",
    sent_at: '2026-05-08T11:00:00Z',
    days_ago: 3,
    gap_days: 124,
    tier: 3,
    href: '/contacts/c3',
  },
]

export default function NewVoicesPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            New voices
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Brand-new contact + two re-emerging cases (over 90d silent).
          </p>
        </header>
        <NewVoices voices={VOICES} />
      </div>
    </main>
  )
}
