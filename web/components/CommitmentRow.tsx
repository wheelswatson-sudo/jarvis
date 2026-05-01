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
        <div className="truncate text-sm">
          {commitment.description}
          {commitment.status === 'done' && (
            <span className="ml-2 text-xs text-emerald-600">✓ done</span>
          )}
          {commitment.status === 'snoozed' && (
            <span className="ml-2 text-xs text-zinc-500">snoozed</span>
          )}
          {commitment.status === 'cancelled' && (
            <span className="ml-2 text-xs text-zinc-400">cancelled</span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
          {commitment.contact_id && commitment.contact_name && (
            <Link
              href={`/contacts/${commitment.contact_id}`}
              className="hover:underline"
            >
              {commitment.contact_name}
            </Link>
          )}
          <span>·</span>
          <span className={overdue ? 'text-red-600' : ''}>
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
            className="rounded-md bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50"
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
            className="rounded-md border border-zinc-200 px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Snooze
          </button>
          <button
            type="button"
            onClick={() => update({ status: 'cancelled' })}
            disabled={pending}
            className="rounded-md border border-zinc-200 px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  )
}
