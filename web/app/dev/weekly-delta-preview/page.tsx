// Dev-only preview for the ContactWeeklyDelta card on /contacts/[id].
import { notFound } from 'next/navigation'
import { ContactWeeklyDelta } from '../../../components/ContactWeeklyDelta'
import type { ContactWeeklyDelta as Delta } from '../../../lib/intelligence/contact-weekly-delta'

const RICH: Delta = {
  has_signal: true,
  entries: [
    {
      kind: 'score',
      label: 'composite',
      delta: 0.12,
      current: 0.74,
      prior: 0.62,
    },
    {
      kind: 'commitment_completed',
      description: 'Sent the revised pricing deck',
      owner: 'me',
      completed_at: '2026-05-10T18:00:00Z',
    },
    {
      kind: 'commitment_completed',
      description: 'Returned the signed MSA',
      owner: 'them',
      completed_at: '2026-05-09T15:00:00Z',
    },
    {
      kind: 'commitment_created',
      description: 'Schedule the kickoff call by Friday',
      owner: 'me',
      created_at: '2026-05-08T17:30:00Z',
    },
    {
      kind: 'message_received',
      direction: 'inbound',
      subject: 'Re: pricing — quick question on the enterprise tier',
      sent_at: '2026-05-10T16:00:00Z',
      count: 3,
    },
    {
      kind: 'message_received',
      direction: 'outbound',
      subject: 'Following up on the deck',
      sent_at: '2026-05-10T18:00:00Z',
      count: 2,
    },
    {
      kind: 'life_event',
      event: 'Started a new role at Stripe',
      date: '2026-05-07',
    },
  ],
}

const EMPTY: Delta = {
  has_signal: false,
  entries: [],
}

export default function WeeklyDeltaPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-2xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Contact weekly delta
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Rich state (every signal type) and the empty state side-by-side.
          </p>
        </header>
        <Variant label="Rich week">
          <ContactWeeklyDelta delta={RICH} />
        </Variant>
        <Variant label="Quiet week">
          <ContactWeeklyDelta delta={EMPTY} />
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
