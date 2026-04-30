'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '../lib/supabase/client'
import { formatRelative } from '../lib/format'
import type { Approval } from '../lib/types'

type WithName = Approval & { contact_name?: string | null }

export function ApprovalCard({ approval }: { approval: WithName }) {
  const router = useRouter()
  const [pending, start] = useTransition()

  function decide(status: 'approved' | 'rejected') {
    start(async () => {
      const supabase = createClient()
      await supabase
        .from('approvals')
        .update({ status, decided_at: new Date().toISOString() })
        .eq('id', approval.id)
      router.refresh()
    })
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700">
              {approval.channel ?? 'unknown'}
            </span>
            <span>· {formatRelative(approval.created_at)}</span>
          </div>
          <div className="mt-2 text-sm font-medium">
            To:{' '}
            {approval.contact_id && approval.contact_name ? (
              <Link
                href={`/contacts/${approval.contact_id}`}
                className="hover:underline"
              >
                {approval.contact_name}
              </Link>
            ) : (
              <span>{approval.recipient ?? 'unknown'}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => decide('approved')}
            disabled={pending}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => decide('rejected')}
            disabled={pending}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
      <div className="rounded-md bg-zinc-50 p-3 text-sm whitespace-pre-wrap">
        {approval.draft}
      </div>
      {approval.context && (
        <p className="mt-3 text-xs text-zinc-500">
          Context: {approval.context}
        </p>
      )}
    </div>
  )
}
