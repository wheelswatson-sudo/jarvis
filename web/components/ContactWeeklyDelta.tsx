import type {
  ContactWeeklyDelta,
  WeeklyDeltaEntry,
} from '../lib/intelligence/contact-weekly-delta'

export function ContactWeeklyDelta({ delta }: { delta: ContactWeeklyDelta }) {
  if (!delta.has_signal) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
          This week
        </div>
        <p className="mt-1.5 text-xs text-zinc-500">
          Nothing notable in the last 7 days — no messages, commitments, or
          score movement to surface.
        </p>
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
        This week
      </div>
      <ul className="mt-2 space-y-2">
        {delta.entries.map((e, i) => (
          <li key={i} className="flex items-start gap-3 text-sm">
            <span aria-hidden="true" className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-500" />
            <span className="text-zinc-200">{renderEntry(e)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function renderEntry(e: WeeklyDeltaEntry): React.ReactNode {
  switch (e.kind) {
    case 'score': {
      const deltaPct = Math.round(e.delta * 100)
      const arrow = deltaPct > 0 ? '↑' : deltaPct < 0 ? '↓' : '·'
      const accent =
        deltaPct > 0 ? 'text-emerald-300' : deltaPct < 0 ? 'text-amber-300' : 'text-zinc-300'
      return (
        <span>
          <span className={`tabular-nums ${accent}`}>
            {arrow} {Math.abs(deltaPct)}%
          </span>{' '}
          composite score over 7d
          {e.prior != null && e.current != null && (
            <span className="text-xs text-zinc-500">
              {' '}
              ({Math.round(e.prior * 100)}% → {Math.round(e.current * 100)}%)
            </span>
          )}
        </span>
      )
    }
    case 'commitment_completed': {
      const who = e.owner === 'them' ? 'they delivered' : 'you delivered'
      return (
        <span>
          <span className="text-emerald-300">✓</span> {who}:{' '}
          <span className="text-zinc-300">"{truncate(e.description, 80)}"</span>
        </span>
      )
    }
    case 'commitment_created':
      return (
        <span>
          New commitment:{' '}
          <span className="text-zinc-300">"{truncate(e.description, 80)}"</span>
          {e.owner && <span className="text-xs text-zinc-500"> ({e.owner})</span>}
        </span>
      )
    case 'message_received':
      return (
        <span>
          {e.direction === 'inbound' ? 'Received' : 'Sent'} {e.count} message
          {e.count === 1 ? '' : 's'}
          {e.subject && (
            <span className="text-xs text-zinc-500">
              {' '}
              · latest: "{truncate(e.subject, 60)}"
            </span>
          )}
        </span>
      )
    case 'life_event':
      return (
        <span>
          <span className="text-emerald-300">✦</span> Life event:{' '}
          <span className="text-zinc-300">{truncate(e.event, 80)}</span>
        </span>
      )
    default:
      return null
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}
