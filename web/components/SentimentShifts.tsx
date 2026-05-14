import Link from 'next/link'
import type {
  SentimentShift,
  SentimentDirection,
  SentimentShiftSource,
} from '../lib/intelligence/sentiment-shifts'
import { Card, SectionHeader } from './cards'
import { HelpDot } from './Tooltip'

const DIRECTION_META: Record<
  SentimentDirection,
  { label: string; chip: string; arrow: string; arrowCls: string }
> = {
  cooled: {
    label: 'Cooling',
    chip: 'bg-amber-500/10 text-amber-200 ring-amber-500/30',
    arrow: '↓',
    arrowCls: 'text-amber-300',
  },
  warmed: {
    label: 'Warming',
    chip: 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/30',
    arrow: '↑',
    arrowCls: 'text-emerald-300',
  },
}

const SEVERITY_DOT: Record<SentimentShift['severity'], string> = {
  critical: 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.6)]',
  high: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]',
  medium: 'bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.45)]',
}

const SOURCE_LABEL: Record<SentimentShiftSource, string> = {
  sentiment: 'Sentiment',
  composite: 'Composite',
}

export function SentimentShifts({ shifts }: { shifts: SentimentShift[] }) {
  if (shifts.length === 0) return null
  return (
    <section className="animate-fade-up">
      <SectionHeader
        eyebrow="Tone shifts"
        title={
          <span className="inline-flex items-center gap-2">
            Relationship signal changed{' '}
            <span className="text-zinc-600 font-normal">({shifts.length})</span>
            <HelpDot content="Contacts whose sentiment or composite relationship score moved meaningfully in the last two weeks. Cooling alerts are the early-warning signal — warming alerts tell you something is working." />
          </span>
        }
        subtitle={`Compared to ~2 weeks ago — sentiment delta above ${Math.round(0.2 * 100)}% or composite drop above ${Math.round(0.15 * 100)}%.`}
      />
      <div className="grid gap-3 aiea-stagger">
        {shifts.map((shift) => (
          <ShiftCard key={shift.id} shift={shift} />
        ))}
      </div>
    </section>
  )
}

function ShiftCard({ shift }: { shift: SentimentShift }) {
  const meta = DIRECTION_META[shift.direction]
  const deltaPct = Math.round(shift.delta * 100)
  const currentPct = Math.round(shift.current * 100)
  const priorPct = Math.round(shift.prior * 100)

  return (
    <Card>
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[shift.severity]}`}
        />
        <Link
          href={shift.href}
          className="group min-w-0 flex-1 space-y-1"
          aria-label={`Open ${shift.contact_name}`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${meta.chip}`}
            >
              <span aria-hidden="true" className={meta.arrowCls}>
                {meta.arrow}
              </span>
              {meta.label}
            </span>
            <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
              {shift.severity}
            </span>
            <span className="text-[10px] tabular-nums text-zinc-500">
              · {shift.days_between}d window
            </span>
            <span className="text-[10px] tabular-nums text-zinc-500">
              · {SOURCE_LABEL[shift.source]}
            </span>
          </div>
          <p className="text-sm text-zinc-100 group-hover:text-white">
            {shift.hint}
          </p>
          <div className="flex items-center gap-3 pt-0.5">
            <DeltaBar prior={priorPct} current={currentPct} direction={shift.direction} />
            <span className="text-[11px] tabular-nums text-zinc-500">
              Δ {deltaPct}%
            </span>
          </div>
        </Link>
        <Link
          href={shift.href}
          className="shrink-0 self-center text-[11px] font-medium text-violet-300 transition-colors hover:text-violet-200"
        >
          View →
        </Link>
      </div>
    </Card>
  )
}

// Tiny prior→current bar pair. Width-normalized so the eye can read
// magnitude at a glance without doing the math in their head.
function DeltaBar({
  prior,
  current,
  direction,
}: {
  prior: number
  current: number
  direction: SentimentDirection
}) {
  const accent = direction === 'cooled' ? 'bg-amber-400/70' : 'bg-emerald-400/70'
  const baseline = 'bg-zinc-700/70'
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-1">
        <span className="text-[10px] tabular-nums text-zinc-500">{prior}%</span>
        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-white/[0.04]">
          <div
            className={`h-full rounded-full ${baseline}`}
            style={{ width: `${Math.max(2, prior)}%` }}
          />
        </div>
      </div>
      <span aria-hidden="true" className="text-[10px] text-zinc-600">
        →
      </span>
      <div className="flex items-center gap-1">
        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-white/[0.04]">
          <div
            className={`h-full rounded-full ${accent}`}
            style={{ width: `${Math.max(2, current)}%` }}
          />
        </div>
        <span className="text-[10px] tabular-nums text-zinc-300">
          {current}%
        </span>
      </div>
    </div>
  )
}
