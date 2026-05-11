import Link from 'next/link'
import type { RecentLifeEvent } from '../lib/intelligence/recent-life-events'
import { Card, SectionHeader } from './cards'
import { HelpDot } from './Tooltip'

export function RecentLifeEvents({ events }: { events: RecentLifeEvent[] }) {
  if (events.length === 0) return null
  return (
    <section className="animate-fade-up">
      <SectionHeader
        eyebrow="Acknowledge"
        title={
          <span className="inline-flex items-center gap-2">
            Recent life events{' '}
            <span className="text-zinc-600 font-normal">({events.length})</span>
            <HelpDot content="Promotions, big losses, life moves you've captured in personal_details.life_events. The EA move is timing: bringing it up in the same week it happened, not three months later." />
          </span>
        }
        subtitle="Things to acknowledge — fresh life events from the last two weeks."
      />
      <div className="grid gap-3 aiea-stagger">
        {events.map((e) => (
          <LifeEventCard key={e.id} event={e} />
        ))}
      </div>
    </section>
  )
}

function LifeEventCard({ event }: { event: RecentLifeEvent }) {
  const whenLabel =
    event.days_ago === 0
      ? 'Today'
      : event.days_ago === 1
        ? 'Yesterday'
        : `${event.days_ago}d ago`

  return (
    <Link href={`/contacts/${event.contact_id}`} className="group block">
      <Card interactive>
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-base ring-1 ring-inset ring-emerald-500/30"
          >
            ✦
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-200 ring-1 ring-inset ring-emerald-500/30">
                Life event
              </span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                {whenLabel}
              </span>
              {event.tier != null && (
                <span className="text-[10px] tabular-nums text-zinc-500">
                  · T{event.tier}
                </span>
              )}
            </div>
            <p className="truncate text-sm font-medium text-zinc-100 group-hover:text-white">
              {event.contact_name}{' '}
              <span className="font-normal text-zinc-400">— {event.event}</span>
            </p>
          </div>
          <span className="shrink-0 self-center text-[11px] font-medium text-violet-300 transition-colors group-hover:text-violet-200">
            Acknowledge →
          </span>
        </div>
      </Card>
    </Link>
  )
}
