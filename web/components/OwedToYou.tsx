import Link from 'next/link'
import type { OwedToYou as OwedItem } from '../lib/intelligence/owed-to-you'
import { Card, SectionHeader } from './cards'
import { HelpDot } from './Tooltip'

const SEVERITY_DOT: Record<OwedItem['severity'], string> = {
  critical: 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.6)]',
  high: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]',
  medium: 'bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.45)]',
}

export function OwedToYou({ items }: { items: OwedItem[] }) {
  if (items.length === 0) return null
  return (
    <section className="animate-fade-up">
      <SectionHeader
        eyebrow="Owed to you"
        title={
          <span className="inline-flex items-center gap-2">
            They owe you something{' '}
            <span className="text-zinc-600 font-normal">({items.length})</span>
            <HelpDot content="Open commitments where the other person is on the hook. Overdue items first, then due-soon. The EA move is a soft nudge, not radio silence." />
          </span>
        }
        subtitle="Nudge candidates — what others promised you but haven't delivered."
      />
      <div className="grid gap-3 aiea-stagger">
        {items.map((item) => (
          <OwedCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  )
}

function OwedCard({ item }: { item: OwedItem }) {
  const dueLabel = formatDue(item.days_relative)
  return (
    <Link href={item.href} className="group block">
      <Card interactive>
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                {item.severity}
              </span>
              <span className="text-[10px] tabular-nums text-zinc-500">· {dueLabel}</span>
            </div>
            <p className="text-sm text-zinc-100 group-hover:text-white">
              {item.hint}
            </p>
          </div>
          <span className="shrink-0 self-center text-[11px] font-medium text-violet-300 transition-colors group-hover:text-violet-200">
            Nudge →
          </span>
        </div>
      </Card>
    </Link>
  )
}

function formatDue(daysRelative: number): string {
  if (daysRelative < 0) return `${-daysRelative}d overdue`
  if (daysRelative === 0) return 'due today'
  if (daysRelative === 1) return 'due tomorrow'
  return `due in ${daysRelative}d`
}
