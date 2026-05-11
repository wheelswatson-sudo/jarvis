// Dev-only preview for ConnectorSuggestions.
import { notFound } from 'next/navigation'
import { ConnectorSuggestions } from '../../../components/ConnectorSuggestions'
import type { ConnectorSuggestion } from '../../../lib/intelligence/connector-suggestions'

const SUGGESTIONS: ConnectorSuggestion[] = [
  {
    id: 'connect:1',
    requester_contact_id: 'c-mark',
    requester_name: 'Mark Jensen',
    match_contact_id: 'c-jane',
    match_name: 'Jane Park',
    topic: 'cfo',
    match_field: 'title',
    match_value: 'Fractional CFO',
    message_id: 'm1',
    message_subject: 'Looking for a CFO recommendation',
    message_snippet: "We're moving fast on Series A prep and need a CFO who's done it before…",
    message_sent_at: '2026-05-11T09:00:00Z',
    days_ago: 0,
    requester_score: 0.71,
    match_score: 0.66,
    href: '/contacts/c-mark',
  },
  {
    id: 'connect:2',
    requester_contact_id: 'c-sarah',
    requester_name: 'Sarah Chen',
    match_contact_id: 'c-dev',
    match_name: 'Devon Park',
    topic: 'designer',
    match_field: 'topics_of_interest',
    match_value: 'product designer',
    message_id: 'm2',
    message_subject: 'Need a designer recommendation',
    message_snippet: "Trying to find a designer who can do brand + product…",
    message_sent_at: '2026-05-09T14:00:00Z',
    days_ago: 2,
    requester_score: 0.62,
    match_score: 0.48,
    href: '/contacts/c-sarah',
  },
]

export default function ConnectorPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Connector suggestions
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Two fixtures — title match (CFO) and topics_of_interest match
            (product designer).
          </p>
        </header>
        <ConnectorSuggestions suggestions={SUGGESTIONS} />
      </div>
    </main>
  )
}
