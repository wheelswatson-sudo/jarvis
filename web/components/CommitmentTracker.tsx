'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useToast } from './Toast'
import type { Commitment } from '../lib/types'

export type EnrichedCommitment = Commitment & {
  contact_name: string | null
}

type Bucket = {
  key: 'overdue' | 'today' | 'week' | 'upcoming'
  label: string
  tone: string
  items: EnrichedCommitment[]
}

function bucketize(commitments: EnrichedCommitment[]): Bucket[] {
  const now = new Date()
  const startOfTomorrow = new Date(now)
  startOfTomorrow.setHours(24, 0, 0, 0)
  const inOneWeek = new Date(now)
  inOneWeek.setDate(inOneWeek.getDate() + 7)

  const open = commitments.filter((c) => c.status === 'open')

  const overdue = open.filter(
    (c) => c.due_at && new Date(c.due_at) < now,
  )
  const today = open.filter(
    (c) =>
      c.due_at &&
      new Date(c.due_at) >= now &&
      new Date(c.due_at) < startOfTomorrow,
  )
  const week = open.filter(
    (c) =>
      c.due_at &&
      new Date(c.due_at) >= startOfTomorrow &&
      new Date(c.due_at) < inOneWeek,
  )
  const upcoming = open.filter(
    (c) => !c.due_at || new Date(c.due_at) >= inOneWeek,
  )

  return [
    { key: 'overdue', label: 'Overdue', tone: 'red', items: overdue },
    { key: 'today', label: 'Due today', tone: 'amber', items: today },
    { key: 'week', label: 'This week', tone: 'violet', items: week },
    { key: 'upcoming', label: 'Upcoming', tone: 'zinc', items: upcoming },
  ]
}

function daysOverdue(c: EnrichedCommitment): number | null {
  if (!c.due_at) return null
  const diff = Date.now() - new Date(c.due_at).getTime()
  if (diff <= 0) return null
  return Math.floor(diff / (24 * 60 * 60 * 1000))
}

const TONE_DOT: Record<string, string> = {
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  violet: 'bg-violet-500',
  zinc: 'bg-zinc-600',
}

export function CommitmentTracker({
  commitments,
  showFilter = false,
}: {
  commitments: EnrichedCommitment[]
  showFilter?: boolean
}) {
  const [filter, setFilter] = useState<'open' | 'overdue' | 'all'>('open')

  const filtered = commitments.filter((c) => {
    if (filter === 'all') return true
    if (filter === 'overdue') {
      return (
        c.status === 'open' &&
        c.due_at != null &&
        new Date(c.due_at) < new Date()
      )
    }
    return c.status === 'open'
  })

  const buckets = bucketize(filtered)

  return (
    <div className="space-y-6">
      {showFilter && (
        <div className="flex gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-1 text-xs w-fit">
          {(['open', 'overdue', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1 capitalize transition-all ${
                filter === f
                  ? 'bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/15 text-white ring-1 ring-inset ring-violet-500/30'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      )}
      {buckets.map((b) => (
        <section key={b.key}>
          <header className="mb-2 flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${TONE_DOT[b.tone]}`} />
            <h3 className="text-sm font-medium text-zinc-200">{b.label}</h3>
            <span className="text-xs text-zinc-500">({b.items.length})</span>
          </header>
          {b.items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/[0.06] bg-white/[0.015] p-3 text-xs text-zinc-500">
              {b.key === 'overdue'
                ? 'Nothing overdue. Clean.'
                : 'Nothing here.'}
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-xl aiea-glass">
              {b.items.map((c) => (
                <Row key={c.id} commitment={c} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

function Row({ commitment }: { commitment: EnrichedCommitment }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const overdue = daysOverdue(commitment)

  async function patch(updates: Record<string, unknown>): Promise<boolean> {
    const res = await fetch('/api/commitments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: commitment.id, ...updates }),
    })
    return res.ok
  }

  function markDone() {
    const prevStatus = commitment.status
    const prevDue = commitment.due_at
    start(async () => {
      const ok = await patch({ status: 'done' })
      if (!ok) {
        toast.error("Couldn't mark done — please try again")
        return
      }
      router.refresh()
      toast.success('Marked done', {
        label: 'Undo',
        onClick: () => {
          patch({ status: prevStatus, due_at: prevDue }).then(() =>
            router.refresh(),
          )
        },
      })
    })
  }

  function snooze7d() {
    const next = new Date()
    next.setDate(next.getDate() + 7)
    start(async () => {
      const ok = await patch({
        status: 'snoozed',
        due_at: next.toISOString(),
      })
      if (!ok) {
        toast.error("Couldn't snooze")
        return
      }
      toast.info('Snoozed 7 days')
      router.refresh()
    })
  }

  return (
    <li className="group flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-white/[0.025]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-zinc-100">{commitment.description}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
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
          {commitment.due_at && (
            <>
              <span aria-hidden="true">·</span>
              <span className={overdue ? 'text-rose-300' : ''}>
                due {new Date(commitment.due_at).toLocaleDateString()}
                {overdue ? ` · ${overdue}d overdue` : ''}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-1 opacity-70 transition-opacity group-hover:opacity-100">
        <button
          disabled={pending}
          onClick={markDone}
          className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
        >
          Done
        </button>
        <button
          disabled={pending}
          onClick={snooze7d}
          className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-white/[0.18] disabled:opacity-50"
        >
          Snooze 7d
        </button>
      </div>
    </li>
  )
}
