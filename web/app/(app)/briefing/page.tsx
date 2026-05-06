import { createClient } from '../../../lib/supabase/server'
import { BriefingView } from '../../../components/BriefingView'
import type { BriefingPayload } from '../../../lib/intelligence/daily-briefing'

export const dynamic = 'force-dynamic'

type CachedBriefing = {
  id: string
  user_id: string
  briefing_date: string
  payload: BriefingPayload
  markdown: string
  generated_at: string
}

async function loadLatestBriefing(): Promise<CachedBriefing | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data, error } = await supabase
    .from('daily_briefings')
    .select('*')
    .eq('user_id', user.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Table may not exist yet on a project where migration 008 hasn't been
  // applied — fail open so the page renders with the empty state.
  if (error) return null
  return (data as CachedBriefing | null) ?? null
}

export default async function BriefingPage() {
  const initial = await loadLatestBriefing()
  return <BriefingView initial={initial} />
}
