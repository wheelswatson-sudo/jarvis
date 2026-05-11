import Link from 'next/link'
import type {
  UpcomingMilestone,
  MilestoneKind,
} from '../lib/intelligence/milestone-radar'
import { Card, SectionHeader } from './cards'
import { HelpDot } from './Tooltip'

const KIND_META: Record<MilestoneKind, { chip: string; eyebrow: string; glyph: string }> = {
  birthday: {
    chip: 'bg-fuchsia-500/10 text-fuchsia-200 ring-fuchsia-500/30',
    eyebrow: 'Birthday',
    glyph: '🎂',
  },
  milestone: {
    chip: 'bg-violet-500/10 text-violet-200 ring-violet-500/30',
    eyebrow: 'Milestone',
    glyph: '✦',
  },
}

export function MilestoneRadar({
  milestones,
}: {
  milestones: UpcomingMilestone[]
}) {
  if (milestones.length === 0) return null
  return (
    <section className="animate-fade-up">
      <SectionHeader
        eyebrow="Coming up"
        title={
          <span className="inline-flex items-center gap-2">
            On the radar{' '}
            <span className="text-zinc-600 font-normal">({milestones.length})</span>
            <HelpDot content="Upcoming birthdays and key milestones for your tracked contacts. Annual recurrence is inferred from month-day; the year (if known) lets you say 'happy 40th'." />
          </span>
        }
        subtitle="Birthdays and relationship milestones in the next two weeks."
      />
      <div className="grid gap-3 aiea-stagger">
        {milestones.map((m) => (
          <MilestoneCard key={m.id} milestone={m} />
        ))}
      </div>
    </section>
  )
}

function MilestoneCard({ milestone }: { milestone: UpcomingMilestone }) {
  const meta = KIND_META[milestone.kind]
  const whenLabel =
    milestone.days_until === 0
      ? 'Today'
      : milestone.days_until === 1
        ? 'Tomorrow'
        : `In ${milestone.days_until}d`
  const dateLabel = formatDateShort(milestone.next_date)
  const ageNote = ageHint(milestone)

  return (
    <Link href={`/contacts/${milestone.contact_id}`} className="group block">
      <Card interactive>
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-base"
          >
            {meta.glyph}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${meta.chip}`}
              >
                {meta.eyebrow}
              </span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                {whenLabel}
              </span>
              <span className="text-[10px] tabular-nums text-zinc-500">
                · {dateLabel}
              </span>
              {milestone.tier != null && (
                <span className="text-[10px] tabular-nums text-zinc-500">
                  · T{milestone.tier}
                </span>
              )}
            </div>
            <p className="truncate text-sm font-medium text-zinc-100 group-hover:text-white">
              {milestone.contact_name}
              {milestone.kind === 'milestone' && (
                <span className="ml-1.5 font-normal text-zinc-400">
                  — {milestone.label}
                </span>
              )}
            </p>
            {ageNote && (
              <p className="text-[11px] text-zinc-500">{ageNote}</p>
            )}
          </div>
          <span className="shrink-0 self-center text-[11px] font-medium text-violet-300 transition-colors group-hover:text-violet-200">
            Send →
          </span>
        </div>
      </Card>
    </Link>
  )
}

function ageHint(m: UpcomingMilestone): string | null {
  if (!m.original_year) return null
  const nextYear = Number(m.next_date.slice(0, 4))
  if (!Number.isFinite(nextYear)) return null
  const age = nextYear - m.original_year
  if (age <= 0 || age > 130) return null
  if (m.kind === 'birthday') return `Turns ${age}`
  return `${age} year${age === 1 ? '' : 's'}`
}

function formatDateShort(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}
