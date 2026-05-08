'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatRelative } from '../lib/format'
import type { PendingChange } from '../lib/types'

type ChangeWithContact = PendingChange & { contact_name: string | null }

type ContactGroup = {
  contactId: string
  contactName: string
  changes: ChangeWithContact[]
}

export function PendingChangesQueue({
  groups,
}: {
  groups: ContactGroup[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const totalCount = useMemo(
    () => groups.reduce((sum, g) => sum + g.changes.length, 0),
    [groups],
  )

  function resolve(ids: string[], action: 'approve' | 'reject') {
    if (ids.length === 0) return
    setErrorMsg(null)
    start(async () => {
      try {
        const res = await fetch('/api/approvals/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, action }),
        })
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as
            | { error?: string }
            | null
          throw new Error(j?.error ?? `Request failed (${res.status})`)
        }
        router.refresh()
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Something went wrong')
      }
    })
  }

  const allIds = useMemo(
    () => groups.flatMap((g) => g.changes.map((c) => c.id)),
    [groups],
  )

  return (
    <div className="space-y-6">
      {totalCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl aiea-glass px-4 py-3">
          <div className="text-sm text-zinc-300">
            <span className="font-semibold text-zinc-100 tabular-nums">{totalCount}</span>{' '}
            pending change{totalCount === 1 ? '' : 's'} across{' '}
            <span className="font-semibold text-zinc-100 tabular-nums">{groups.length}</span>{' '}
            contact{groups.length === 1 ? '' : 's'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => resolve(allIds, 'reject')}
              disabled={pending}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.18] hover:text-white disabled:opacity-40"
            >
              Reject all
            </button>
            <button
              type="button"
              onClick={() => resolve(allIds, 'approve')}
              disabled={pending}
              className="rounded-lg aiea-cta px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Approve all
            </button>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.08] px-4 py-3 text-sm text-rose-300">
          {errorMsg}
        </div>
      )}

      <div className="space-y-4 aiea-stagger">
        {groups.map((group) => (
          <ContactGroupCard
            key={group.contactId}
            group={group}
            pending={pending}
            onResolve={resolve}
          />
        ))}
      </div>
    </div>
  )
}

function ContactGroupCard({
  group,
  pending,
  onResolve,
}: {
  group: ContactGroup
  pending: boolean
  onResolve: (ids: string[], action: 'approve' | 'reject') => void
}) {
  const groupIds = group.changes.map((c) => c.id)

  return (
    <div className="overflow-hidden rounded-2xl aiea-glass">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.05] bg-gradient-to-r from-indigo-500/[0.06] via-violet-500/[0.04] to-fuchsia-500/[0.06] px-5 py-4">
        <div className="min-w-0">
          <Link
            href={`/contacts/${group.contactId}`}
            className="text-base font-medium text-zinc-100 transition-colors hover:text-white"
          >
            {group.contactName}
          </Link>
          <div className="mt-0.5 text-xs text-zinc-500">
            {group.changes.length} pending change
            {group.changes.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onResolve(groupIds, 'reject')}
            disabled={pending}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.18] hover:text-white disabled:opacity-40"
          >
            Reject all
          </button>
          <button
            type="button"
            onClick={() => onResolve(groupIds, 'approve')}
            disabled={pending}
            className="rounded-lg aiea-cta px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Approve all
          </button>
        </div>
      </div>

      <ul className="divide-y divide-white/[0.05]">
        {group.changes.map((change) => (
          <ChangeRow
            key={change.id}
            change={change}
            pending={pending}
            onResolve={onResolve}
          />
        ))}
      </ul>
    </div>
  )
}

function ChangeRow({
  change,
  pending,
  onResolve,
}: {
  change: ChangeWithContact
  pending: boolean
  onResolve: (ids: string[], action: 'approve' | 'reject') => void
}) {
  return (
    <li className="grid grid-cols-1 gap-4 px-5 py-4 transition-colors hover:bg-white/[0.02] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-medium uppercase tracking-wide text-zinc-300">
            {change.field_name}
          </span>
          <span className="rounded-md border border-violet-500/30 bg-violet-500/[0.08] px-2 py-0.5 font-medium text-violet-300">
            {change.source}
          </span>
          <span className="text-zinc-500">
            · {formatRelative(change.created_at)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <ValuePill value={change.old_value} tone="old" />
          <span aria-hidden="true" className="text-zinc-500">
            →
          </span>
          <ValuePill value={change.new_value} tone="new" />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:justify-end">
        <button
          type="button"
          onClick={() => onResolve([change.id], 'reject')}
          disabled={pending}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.18] hover:text-white disabled:opacity-40"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => onResolve([change.id], 'approve')}
          disabled={pending}
          className="rounded-lg aiea-cta px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Approve
        </button>
      </div>
    </li>
  )
}

function ValuePill({
  value,
  tone,
}: {
  value: string | null
  tone: 'old' | 'new'
}) {
  const empty = value == null || value.length === 0
  const base = 'max-w-full truncate rounded-md px-2 py-1 text-sm'
  const cls =
    tone === 'old'
      ? `${base} border border-white/[0.06] bg-white/[0.02] text-zinc-400 line-through decoration-zinc-600`
      : `${base} border border-fuchsia-500/30 bg-fuchsia-500/[0.10] text-fuchsia-200`
  return (
    <span className={cls} title={empty ? '(empty)' : (value ?? '')}>
      {empty ? <span className="italic text-zinc-500">empty</span> : value}
    </span>
  )
}
