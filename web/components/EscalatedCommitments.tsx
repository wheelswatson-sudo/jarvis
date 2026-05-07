import Link from 'next/link'
import {
  ESCALATION_TONE,
  compareEscalation,
  getEscalation,
  type EscalationInfo,
  type EscalationLevel,
} from '../lib/contacts/commitment-escalation'
import type { EnrichedCommitment } from './CommitmentTracker'

type Row = {
  commitment: EnrichedCommitment
  info: EscalationInfo
}

// Levels we surface in the "needing action" section. "future" commitments are
// more than 3 days out — they're not yet on the radar, so we hide them here.
const ACTIONABLE: EscalationLevel[] = [
  'critical',
  'escalated',
  'urgent',
  'soft',
]

export function EscalatedCommitments({
  commitments,
  now = Date.now(),
  limit = 8,
}: {
  commitments: EnrichedCommitment[]
  now?: number
  limit?: number
}) {
  const open = commitments.filter((c) => c.status === 'open')
  // Track commitments without a due_at separately so they don't silently
  // disappear from the dashboard — we surface a count + link instead.
  const undatedCount = open.filter((c) => !c.due_at).length

  const rows: Row[] = open
    .map((c) => {
      const info = getEscalation(c.due_at, now)
      return info ? { commitment: c, info } : null
    })
    .filter((r): r is Row => r !== null)
    .filter((r) => ACTIONABLE.includes(r.info.level))
    .sort((a, b) => compareEscalation(a.info, b.info))

  const critical = rows.some((r) => r.info.level === 'critical')

  if (rows.length === 0) {
    return (
      <div className="space-y-2">
        <div className="rounded-xl aiea-glass p-5 text-sm text-zinc-500">
          Nothing urgent. Every active commitment is more than three days out.
        </div>
        {undatedCount > 0 && <UndatedNote count={undatedCount} />}
      </div>
    )
  }

  const visible = rows.slice(0, limit)
  const hidden = rows.length - visible.length

  return (
    <div className="space-y-3">
      {critical && (
        <div className="rounded-xl border border-red-500/40 bg-red-600/10 p-3 text-xs font-medium uppercase tracking-[0.16em] text-red-200">
          Critical: a commitment is more than 7 days overdue.
        </div>
      )}
      <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-xl aiea-glass">
        {visible.map(({ commitment, info }) => (
          <EscalationRow
            key={commitment.id}
            commitment={commitment}
            info={info}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-xs text-zinc-500">
          + {hidden} more — see{' '}
          <Link
            href="/commitments"
            className="text-violet-300 hover:text-violet-200 hover:underline"
          >
            all commitments
          </Link>
          .
        </p>
      )}
      {undatedCount > 0 && <UndatedNote count={undatedCount} />}
    </div>
  )
}

function UndatedNote({ count }: { count: number }) {
  return (
    <p className="text-xs text-zinc-500">
      <span className="text-zinc-400">{count}</span> open commitment
      {count === 1 ? '' : 's'} without a due date —{' '}
      <Link
        href="/commitments"
        className="text-violet-300 hover:text-violet-200 hover:underline"
      >
        review and add dates
      </Link>
      .
    </p>
  )
}

function EscalationRow({
  commitment,
  info,
}: {
  commitment: EnrichedCommitment
  info: EscalationInfo
}) {
  const tone = ESCALATION_TONE[info.level]
  const detail =
    info.level === 'soft'
      ? info.daysUntilDue === 0
        ? 'due today'
        : `due in ${info.daysUntilDue}d`
      : `${info.daysOverdue}d overdue`

  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`}
            aria-hidden="true"
          />
          <span className="truncate text-zinc-100">
            {commitment.description}
          </span>
        </div>
        <div className="mt-1 ml-3.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
          {commitment.contact_name && commitment.contact_id ? (
            <Link
              href={`/contacts/${commitment.contact_id}`}
              className="text-violet-300 transition-colors hover:text-violet-200 hover:underline"
            >
              {commitment.contact_name}
            </Link>
          ) : (
            <span>no contact</span>
          )}
          <span aria-hidden="true">·</span>
          <span
            className={
              commitment.owner === 'them'
                ? 'text-fuchsia-300'
                : 'text-indigo-300'
            }
          >
            {commitment.owner === 'them' ? 'they owe' : 'you owe'}
          </span>
          <span aria-hidden="true">·</span>
          <span>{detail}</span>
        </div>
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone.badge}`}
      >
        {tone.label}
      </span>
    </li>
  )
}
