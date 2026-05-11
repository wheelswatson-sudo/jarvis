import Link from 'next/link'
import { createClient } from '../../../lib/supabase/server'
import { EmptyState, PageHeader } from '../../../components/cards'
import {
  ExecutiveDigestView,
  type DigestViewModel,
} from '../../../components/ExecutiveDigestView'
import type { ExecutiveDigestPayload } from '../../../lib/intelligence/executive-digest'

export const dynamic = 'force-dynamic'

type DigestRow = {
  id: string
  user_id: string
  week_starting: string
  payload: ExecutiveDigestPayload
  markdown: string
  model: string | null
  generated_at: string
}

async function loadLatestDigest(): Promise<DigestRow | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data, error } = await supabase
    .from('executive_digests')
    .select('*')
    .eq('user_id', user.id)
    .order('week_starting', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Fail open if the table isn't deployed yet — render the empty state
  // rather than throwing.
  if (error) return null
  return (data as DigestRow | null) ?? null
}

export default async function DigestPage() {
  const digest = await loadLatestDigest()
  if (!digest) {
    return (
      <div className="space-y-10">
        <PageHeader
          eyebrow="Friday memo"
          title="Executive digest"
          subtitle="Your chief-of-staff weekly summary."
        />
        <EmptyState
          title="No digest yet"
          body="The first digest will land Friday morning after the cron runs. Activity from the last 7 days will be synthesised into a 60-second memo here."
          action={
            <Link
              href="/home"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 hover:border-violet-500/40 hover:bg-white/[0.06]"
            >
              Back to dashboard
            </Link>
          }
        />
      </div>
    )
  }
  const viewModel: DigestViewModel = {
    payload: digest.payload,
    markdown: digest.markdown,
  }
  return <ExecutiveDigestView digest={viewModel} />
}
