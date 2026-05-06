'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '../lib/supabase/client'
import { trackEventClient } from '../lib/events-client'
import { formatDate } from '../lib/format'
import type { Commitment } from '../lib/types'

type WithContactName = Commitment & { contact_name?: string | null }

export function CommitmentRow({
  commitment,
  showActions = true,
}: {
  commitment: WithContactName
  showActions?: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()

  function update(patch: Partial<Commitment>) {
    start(async () => {
      const supabase = createClient()
      await supabase
        .from('commitments')
        .update(patch)
        .eq('id', commitment.id)
      if (patch.status === 'done') {
        trackEventClient({
          eventType: 'commitment_completed',
          contactId: commitment.contact_id ?? null,
          metadata: {
            commitment_id: commitment.id,
            description: commitment.description,
            was_overdue: !!overdue,
          },
        })
      }
      router.refresh()
    })
  }

  const overdue =
    commitment.status === 'open' &&
    commitment.due_at &&
    commitment.due_at < new Date().toISOString()

  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm text-zinc-100">
          {commitment.description}
          {commitment.status === 'done' && (
            <span className="ml-2 text-xs text-emerald-300">✓ done</span>
          )}
          {commitment.status === 'snoozed' && (
            <span className="ml-2 text-xs text-zinc-500">snoozed</span>
          )}
          {commitment.status === 'cancelled' && (
            <span className="ml-2 text-xs text-zinc-600">cancelled</span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
          {commitment.contact_id && commitment.contact_name && (
            <Link
              href={`/contacts/${commitment.contact_id}`}
              className="text-violet-300 hover:underline"
            >
              {commitment.contact_name}
            </Link>
          )}
          <span aria-hidden="true">·</span>
          <span className={overdue ? 'text-rose-300' : ''}>
            due {formatDate(commitment.due_at)}
          </span>
        </div>
      </div>
      {showActions && commitment.status === 'open' && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() =>
              update({
                status: 'done',
                completed_at: new Date().toISOString(),
              })
            }
            disabled={pending}
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
          >
            Done
          </button>
          <button
            type="button"
            onClick={() => {
              const next = new Date()
              next.setDate(next.getDate() + 7)
              update({ status: 'snoozed', due_at: next.toISOString() })
            }}
            disabled={pending}
            className="rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-white/[0.18] disabled:opacity-50"
          >
            Snooze
          </button>
          <button
            type="button"
            onClick={() => update({ status: 'cancelled' })}
            disabled={pending}
            className="rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-1 text-xs text-zinc-500 transition-colors hover:border-white/[0.18] hover:text-zinc-300 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  )
}
