// Dev-only preview surface for the ForgottenLoops UI.
// Exercises critical/high/medium severity, all three loop types, with and
// without snippet — useful for catching layout regressions and copy drift.

import { notFound } from 'next/navigation'
import { ForgottenLoops } from '../../../components/ForgottenLoops'
import type { ForgottenLoop } from '../../../lib/intelligence/forgotten-loops'

const LOOPS: ForgottenLoop[] = [
  {
    id: 'silent-com:1',
    type: 'silent_overdue_commitment',
    contact_id: 'c1',
    contact_name: 'Mark Jensen',
    message_id: null,
    days: 22,
    severity: 'critical',
    hint: 'You owed Mark Jensen "the Q3 deck with revised pricing" — 22d overdue, no follow-up.',
    snippet: 'the Q3 deck with revised pricing',
    cta: 'Send it',
    href: '/contacts/c1',
    relationship_score: 0.74,
  },
  {
    id: 'unreplied:1',
    type: 'unreplied_inbound',
    contact_id: 'c2',
    contact_name: 'Sarah Chen',
    message_id: 'msg-1',
    days: 12,
    severity: 'high',
    hint: 'Sarah Chen wrote 12d ago — no reply yet.',
    snippet: 'Re: pricing — quick question on the enterprise tier',
    cta: 'Reply',
    href: '/contacts/c2',
    relationship_score: 0.62,
  },
  {
    id: 'unreplied:2',
    type: 'unreplied_inbound',
    contact_id: 'c3',
    contact_name: 'Devon Park',
    message_id: 'msg-2',
    days: 7,
    severity: 'medium',
    hint: 'Devon Park wrote 7d ago — no reply yet.',
    snippet: null,
    cta: 'Reply',
    href: '/contacts/c3',
    relationship_score: 0.34,
  },
  {
    id: 'stalled:1',
    type: 'stalled_outbound',
    contact_id: 'c4',
    contact_name: 'Jamie Russo',
    message_id: 'msg-3',
    days: 18,
    severity: 'high',
    hint: 'You wrote Jamie Russo 18d ago — no response.',
    snippet: 'Following up on intro to your CTO',
    cta: 'Nudge or close',
    href: '/contacts/c4',
    relationship_score: 0.51,
  },
  {
    id: 'silent-com:2',
    type: 'silent_overdue_commitment',
    contact_id: 'c5',
    contact_name: 'Kris Cravens',
    message_id: null,
    days: 9,
    severity: 'medium',
    hint: 'You owed Kris Cravens "share the AIEA roadmap doc" — 9d overdue, no follow-up.',
    snippet: 'share the AIEA roadmap doc',
    cta: 'Send it',
    href: '/contacts/c5',
    relationship_score: null,
  },
]

export default function LoopsPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Forgotten loops surface
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Five fixtures covering all three loop types and severity tiers.
          </p>
        </header>
        <ForgottenLoops loops={LOOPS} />
      </div>
    </main>
  )
}
