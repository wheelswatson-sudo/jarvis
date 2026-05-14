import Link from 'next/link'
import type { TopicWatchHit } from '../lib/intelligence/topic-watch'
import { Card, SectionHeader } from './cards'
import { HelpDot } from './Tooltip'

export function TopicWatch({ hits }: { hits: TopicWatchHit[] }) {
  if (hits.length === 0) return null
  return (
    <section className="animate-fade-up">
      <SectionHeader
        eyebrow="Topic watch"
        title={
          <span className="inline-flex items-center gap-2">
            Tracked topics mentioned{' '}
            <span className="text-zinc-600 font-normal">({hits.length})</span>
            <HelpDot content="When a contact's tracked topics_of_interest shows up in their recent messages. Worth picking up in your reply — it's a conversation hook you've already pre-tagged." />
          </span>
        }
        subtitle="Contacts who just mentioned topics you've tagged for them."
      />
      <div className="grid gap-3 aiea-stagger">
        {hits.map((hit) => (
          <TopicCard key={hit.id} hit={hit} />
        ))}
      </div>
    </section>
  )
}

function TopicCard({ hit }: { hit: TopicWatchHit }) {
  const whenLabel =
    hit.days_ago === 0
      ? 'Today'
      : hit.days_ago === 1
        ? 'Yesterday'
        : `${hit.days_ago}d ago`
  const verb = hit.direction === 'inbound' ? 'wrote' : 'you sent'

  return (
    <Link href={hit.href} className="group block">
      <Card interactive>
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-base ring-1 ring-inset ring-sky-500/30"
          >
            #
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-200 ring-1 ring-inset ring-sky-500/30">
                {hit.topic}
              </span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                {whenLabel}
              </span>
              {hit.tier != null && (
                <span className="text-[10px] tabular-nums text-zinc-500">
                  · T{hit.tier}
                </span>
              )}
            </div>
            <p className="truncate text-sm font-medium text-zinc-100 group-hover:text-white">
              {hit.contact_name}{' '}
              <span className="font-normal text-zinc-400">— {verb}:</span>
            </p>
            <p className="line-clamp-1 text-xs text-zinc-500">
              "{hit.subject || hit.snippet || '(no preview)'}"
            </p>
          </div>
          <span className="shrink-0 self-center text-[11px] font-medium text-violet-300 transition-colors group-hover:text-violet-200">
            Pick up →
          </span>
        </div>
      </Card>
    </Link>
  )
}
