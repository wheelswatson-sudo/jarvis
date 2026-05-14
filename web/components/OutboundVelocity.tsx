import type {
  OutboundVelocity,
  OutboundDirection,
} from '../lib/intelligence/outbound-velocity'
import { Card } from './cards'

const DIRECTION_META: Record<
  OutboundDirection,
  { label: string; chip: string; arrow: string; arrowCls: string; copy: (v: OutboundVelocity) => string }
> = {
  spiking: {
    label: 'Spiking',
    chip: 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/30',
    arrow: '↑',
    arrowCls: 'text-emerald-300',
    copy: (v) =>
      `${v.this_week_count} sent — ${asMultiple(v.ratio)}× your usual week.`,
  },
  steady: {
    label: 'Steady',
    chip: 'bg-violet-500/10 text-violet-200 ring-violet-500/30',
    arrow: '·',
    arrowCls: 'text-violet-300',
    copy: (v) =>
      `${v.this_week_count} sent — within your normal range (avg ${v.baseline_avg_per_week ?? '—'}).`,
  },
  slowing: {
    label: 'Slowing',
    chip: 'bg-amber-500/10 text-amber-200 ring-amber-500/30',
    arrow: '↓',
    arrowCls: 'text-amber-300',
    copy: (v) =>
      `${v.this_week_count} sent — ${asMultiple(v.ratio)}× your usual week.`,
  },
  no_baseline: {
    label: 'New',
    chip: 'bg-zinc-500/10 text-zinc-300 ring-zinc-500/30',
    arrow: '·',
    arrowCls: 'text-zinc-400',
    copy: (v) =>
      `${v.this_week_count} sent this week — need a few more weeks of data for a baseline.`,
  },
}

function asMultiple(ratio: number | null): string {
  if (ratio == null) return '—'
  return ratio.toFixed(2)
}

export function OutboundVelocity({ velocity }: { velocity: OutboundVelocity }) {
  // Don't render at all if there's nothing to say (no messages this week
  // AND no baseline). The empty state would just be noise on /home.
  if (velocity.this_week_count === 0 && velocity.baseline_avg_per_week == null) {
    return null
  }
  const meta = DIRECTION_META[velocity.direction]
  return (
    <Card className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${meta.chip}`}
          >
            <span aria-hidden="true" className={meta.arrowCls}>
              {meta.arrow}
            </span>
            Outbound · {meta.label}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-200">{meta.copy(velocity)}</p>
      </div>
    </Card>
  )
}
