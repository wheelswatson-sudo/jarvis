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
    <div className="rounded-2xl aiea-glass p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="rounded-full bg-white/[0.04] px-2 py-0.5 font-medium text-zinc-300 ring-1 ring-inset ring-white/10">
              {approval.channel ?? 'unknown'}
            </span>
            <span>· {formatRelative(approval.created_at)}</span>
          </div>
          <div className="mt-2 text-sm font-medium text-zinc-100">
            To:{' '}
            {approval.contact_id && approval.contact_name ? (
              <Link
                href={`/contacts/${approval.contact_id}`}
                className="text-violet-300 transition-colors hover:text-violet-200 hover:underline"
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
            className="rounded-lg aiea-cta px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => decide('rejected')}
            disabled={pending}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-white/[0.18] hover:text-white disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
      <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-3 text-sm text-zinc-200 whitespace-pre-wrap">
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
