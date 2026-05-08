import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '../../../../lib/supabase/server'
import { MeetingBriefingCard } from '../../../../components/MeetingBriefingCard'
import { loadBriefingById } from '../../../../lib/contacts/meeting-briefings'

export const dynamic = 'force-dynamic'

export default async function BriefingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const briefing = await loadBriefingById(supabase, user.id, id)
  if (!briefing) notFound()

  return (
    <div className="space-y-6 animate-fade-up">
      <Link
        href="/briefings"
        className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-200"
      >
        <span aria-hidden="true">←</span> All briefings
      </Link>

      <MeetingBriefingCard briefing={briefing} variant="detail" />
    </div>
  )
}
