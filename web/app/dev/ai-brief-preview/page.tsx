// Dev-only preview surface for AiBriefPanel — three states (detail, compact,
// drafting) with realistic narrative copy so we can see the editorial
// hierarchy under load.

import { notFound } from 'next/navigation'
import { AiBriefPanel } from '../../../components/AiBriefPanel'
import type { AiBriefNarrative } from '../../../lib/contacts/meeting-briefings'

const FRESH: AiBriefNarrative = {
  context:
    'You and Sarah Chen (Head of Partnerships, Acme Health) have been circling enterprise pricing for three weeks — she\'s pushed for a written quote twice and you replied with calendar holds.',
  why_now:
    'Procurement signs off this week. If she walks in without a number, the deal slides another quarter and her CFO starts shopping competitors.',
  open_with:
    'Lead with the $48k number, not the agenda. Tell her you confirmed it before this call so she can take a quote into her 4pm.',
  watch: [
    'She brought up audit logs twice — that\'s the line they actually need to clear with security.',
    'Don\'t apologize for the delay. She was the one who asked to push the deeper dive.',
    'If procurement is in the room, defer to whoever speaks first — they\'re the decision maker, not Sarah.',
  ],
  goal: 'Walk out with a verbal yes on the $48k tier and a firm date for the security review.',
  model: 'claude-sonnet-4-6',
  computed_at: '2026-05-09T14:48:00Z',
}

const COMPACT: AiBriefNarrative = {
  context:
    'First 1:1 with Devon Park (Solutions Engineer, Northstar) — he asked deep architectural questions on the demo last week.',
  why_now:
    'He\'s the technical gatekeeper. If he greenlights the integration shape, sales velocity unlocks for the rest of his org.',
  open_with:
    'Bring the architecture diagram on screen first. He won\'t ask, but he was sketching one in chat last call.',
  watch: ['Latency budget came up twice'],
  goal: 'Earn a "this works" from Devon on the proposed integration shape.',
  model: 'claude-sonnet-4-6',
  computed_at: '2026-05-09T18:25:00Z',
}

const STALE: AiBriefNarrative = {
  ...FRESH,
  computed_at: '2026-05-07T09:00:00Z',
}

export default function AiBriefPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-12">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            AiBriefPanel — &ldquo;The read&rdquo;
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Detail · compact · drafting · stale freshness
          </p>
        </header>

        <Showcase title="Detail variant — fully populated">
          <AiBriefPanel narrative={FRESH} variant="detail" meetingTitle="Sarah Chen — pricing review" />
        </Showcase>

        <Showcase title="Compact variant — for /home NextMeetingCard">
          <AiBriefPanel narrative={COMPACT} variant="compact" meetingTitle="Devon Park — technical 1:1" />
        </Showcase>

        <Showcase title="Drafting state — brief hasn't generated yet">
          <AiBriefPanel narrative={null} variant="detail" />
        </Showcase>

        <Showcase title="Stale freshness — older than 24h, amber timestamp">
          <AiBriefPanel narrative={STALE} variant="detail" />
        </Showcase>
      </div>
    </main>
  )
}

function Showcase({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
        {title}
      </h2>
      {children}
    </section>
  )
}
