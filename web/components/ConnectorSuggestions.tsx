import Link from 'next/link'
import type { ConnectorSuggestion } from '../lib/intelligence/connector-suggestions'
import { Card, SectionHeader } from './cards'
import { HelpDot } from './Tooltip'

const FIELD_LABEL: Record<ConnectorSuggestion['match_field'], string> = {
  title: 'role',
  topics_of_interest: 'tracked interest',
  company: 'works at',
}

export function ConnectorSuggestions({
  suggestions,
}: {
  suggestions: ConnectorSuggestion[]
}) {
  if (suggestions.length === 0) return null
  return (
    <section className="animate-fade-up">
      <SectionHeader
        eyebrow="Network"
        title={
          <span className="inline-flex items-center gap-2">
            Intro candidates{' '}
            <span className="text-zinc-600 font-normal">({suggestions.length})</span>
            <HelpDot content="When someone asks for a topic in their recent email, AIEA cross-references the rest of your network for a match (by title, tracked interest, or company). Suggest an intro — or not." />
          </span>
        }
        subtitle="Someone asked for help — and someone else in your network might be the answer."
      />
      <div className="grid gap-3 aiea-stagger">
        {suggestions.map((s) => (
          <SuggestionCard key={s.id} suggestion={s} />
        ))}
      </div>
    </section>
  )
}

function SuggestionCard({ suggestion }: { suggestion: ConnectorSuggestion }) {
  const whenLabel =
    suggestion.days_ago === 0
      ? 'today'
      : suggestion.days_ago === 1
        ? 'yesterday'
        : `${suggestion.days_ago}d ago`
  return (
    <Link href={suggestion.href} className="group block">
      <Card interactive>
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-base ring-1 ring-inset ring-violet-500/30"
          >
            ⇄
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-200 ring-1 ring-inset ring-violet-500/30">
                {suggestion.topic}
              </span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                mentioned {whenLabel}
              </span>
            </div>
            <p className="text-sm text-zinc-100 group-hover:text-white">
              <span className="font-medium">{suggestion.requester_name}</span>{' '}
              asked about "{suggestion.topic}" —{' '}
              <Link
                href={`/contacts/${suggestion.match_contact_id}`}
                className="font-medium text-violet-300 hover:text-violet-200"
              >
                {suggestion.match_name}
              </Link>{' '}
              <span className="text-zinc-400">
                ({FIELD_LABEL[suggestion.match_field]}: "{suggestion.match_value}")
              </span>
            </p>
            {suggestion.message_subject && (
              <p className="line-clamp-1 text-xs text-zinc-500">
                "{suggestion.message_subject}"
              </p>
            )}
          </div>
          <span className="shrink-0 self-center text-[11px] font-medium text-violet-300 transition-colors group-hover:text-violet-200">
            Open thread →
          </span>
        </div>
      </Card>
    </Link>
  )
}
