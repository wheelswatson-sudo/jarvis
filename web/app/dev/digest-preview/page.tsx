// Dev-only preview surface for the executive digest. Exercises a "rich"
// digest where every section has content — useful for verifying layout
// and for tuning narrative copy without waiting for a real Friday cron.

import { notFound } from 'next/navigation'
import {
  ExecutiveDigestView,
  type DigestViewModel,
} from '../../../components/ExecutiveDigestView'
import type { ExecutiveDigestPayload } from '../../../lib/intelligence/executive-digest'

const PAYLOAD: ExecutiveDigestPayload = {
  user_id: 'fixture',
  week_starting: '2026-05-04',
  week_ending: '2026-05-10',
  generated_at: '2026-05-11T13:00:00Z',
  metrics: {
    total_interactions: 142,
    inbound: 71,
    outbound: 71,
    unique_contacts: 38,
    meetings_held: 12,
    commitments_created: 9,
    commitments_completed: 6,
    commitments_overdue: 3,
  },
  warming: [
    {
      contact_id: 'c-kris',
      contact_name: 'Kris Cravens',
      delta_pct: 28,
      current_pct: 81,
      prior_pct: 53,
    },
    {
      contact_id: 'c-jamie',
      contact_name: 'Jamie Russo',
      delta_pct: 21,
      current_pct: 72,
      prior_pct: 51,
    },
  ],
  cooling: [
    {
      contact_id: 'c-mark',
      contact_name: 'Mark Jensen',
      delta_pct: 31,
      current_pct: 41,
      prior_pct: 72,
    },
    {
      contact_id: 'c-sarah',
      contact_name: 'Sarah Chen',
      delta_pct: 22,
      current_pct: 46,
      prior_pct: 68,
    },
  ],
  open_loops: [
    {
      contact_id: 'c-mark',
      contact_name: 'Mark Jensen',
      type: 'silent_overdue_commitment',
      days: 22,
      hint: 'You owed Mark Jensen "the Q3 deck with revised pricing" — 22d overdue, no follow-up.',
    },
    {
      contact_id: 'c-sarah',
      contact_name: 'Sarah Chen',
      type: 'unreplied_inbound',
      days: 12,
      hint: 'Sarah Chen wrote 12d ago — no reply yet.',
    },
    {
      contact_id: 'c-jamie',
      contact_name: 'Jamie Russo',
      type: 'stalled_outbound',
      days: 18,
      hint: 'You wrote Jamie Russo 18d ago — no response.',
    },
  ],
  due_next_week: [
    {
      contact_id: 'c-mark',
      contact_name: 'Mark Jensen',
      description: 'Send the Q3 pricing deck',
      due_at: '2026-05-13T16:00:00Z',
    },
    {
      contact_id: 'c-kris',
      contact_name: 'Kris Cravens',
      description: 'Share AIEA roadmap doc',
      due_at: '2026-05-14T17:00:00Z',
    },
    {
      contact_id: null,
      contact_name: null,
      description: 'Submit Q2 board pre-read',
      due_at: '2026-05-16T18:00:00Z',
    },
  ],
  milestones: [
    {
      contact_id: 'c-kris',
      contact_name: 'Kris Cravens',
      kind: 'birthday',
      label: 'Birthday',
      days_until: 0,
      next_date: '2026-05-11',
    },
    {
      contact_id: 'c-sarah',
      contact_name: 'Sarah Chen',
      kind: 'milestone',
      label: 'Work anniversary at Stripe',
      days_until: 3,
      next_date: '2026-05-14',
    },
  ],
  narrative:
    "Mark Jensen is the highest-risk relationship on the board — the Q3 deck has been overdue 22 days and his sentiment has dropped 31 points in two weeks. Get that out Monday morning, even in draft form, before another email goes unanswered. The Kris and Jamie warming trend is real and worth feeding; one substantive message each next week locks it in. Kris's birthday is today — a single warm message before noon costs nothing and compounds.",
  model: 'claude-sonnet-4-6',
}

const MARKDOWN = `# Executive digest — week of 2026-05-04

_Watson, here's what your week looked like._

${PAYLOAD.narrative}

## By the numbers
- 142 interactions (71 in · 71 out) across 38 contacts
- 12 meetings held
- Commitments: 6 completed · 9 new · 3 overdue

## Relationships on the move
- ↑ Kris Cravens — warming (53% → 81%)
- ↑ Jamie Russo — warming (51% → 72%)
- ↓ Mark Jensen — cooling (72% → 41%)
- ↓ Sarah Chen — cooling (68% → 46%)`

const DIGEST: DigestViewModel = {
  payload: PAYLOAD,
  markdown: MARKDOWN,
}

export default function DigestPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl">
        <ExecutiveDigestView digest={DIGEST} />
      </div>
    </main>
  )
}
