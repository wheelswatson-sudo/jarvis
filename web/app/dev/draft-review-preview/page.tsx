// Dev-only preview surface for the DraftReview UI.
// Mounts the component with mock draft + contact so we can verify layout,
// auto-save behavior (network calls go nowhere — they 404, that's expected),
// and copy/Gmail action buttons without auth or live data.

import { notFound } from 'next/navigation'
import { DraftReview } from '../../../components/DraftReview'
import type { Contact, Draft } from '../../../lib/types'

const NOW = '2026-05-09T19:30:00Z'

const CONTACT: Contact = {
  id: 'preview-contact',
  user_id: '00000000-0000-0000-0000-000000000000',
  first_name: 'Sarah',
  last_name: 'Chen',
  email: 'sarah@acmehealth.com',
  phone: null,
  company: 'Acme Health',
  title: 'Head of Partnerships',
  linkedin: null,
  tier: 2,
  tags: null,
  ltv_estimate: null,
  half_life_days: null,
  sentiment_slope: null,
  sentiment_trajectory: null,
  reciprocity_ratio: null,
  metrics_computed_at: NOW,
  last_interaction_at: '2026-04-27T15:12:00Z',
  personal_details: null,
  relationship_score: 0.62,
  relationship_score_components: null,
  next_follow_up: null,
  pipeline_stage: null,
  pipeline_notes: null,
  pipeline_updated_at: null,
  created_at: NOW,
  updated_at: NOW,
}

const DRAFT: Draft = {
  id: 'preview-draft',
  user_id: '00000000-0000-0000-0000-000000000000',
  contact_id: CONTACT.id,
  message_id: null,
  trigger: 'forgotten_loop',
  subject: null,
  body: `Hey Sarah,

Sorry for the slow turnaround on this. The enterprise tier I quoted is firm at $48k/yr — that gets you the SSO, audit logs, and the dedicated CSM you asked about. Volume tier pricing kicks in at 250+ seats; happy to dig into that if you're sizing up.

Want to put 30 minutes on the calendar next week to walk through the deployment plan?

— Watson`,
  model: 'claude-sonnet-4-6',
  reasoning: 'Matched her last sentence\'s direct register and answered the open price question without restating it.',
  status: 'pending',
  generated_at: '2026-05-09T19:25:00Z',
  reviewed_at: null,
  created_at: NOW,
  updated_at: NOW,
}

export default function DraftReviewPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-4xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Draft review surface
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Mock draft + contact. Auto-save calls 404 here — that's expected.
          </p>
        </header>
        <DraftReview draft={DRAFT} contact={CONTACT} />
      </div>
    </main>
  )
}
