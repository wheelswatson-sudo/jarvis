import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '../../../lib/supabase/server'
import { EmptyState, PageHeader } from '../../../components/cards'
import { MeetingBriefingCard } from '../../../components/MeetingBriefingCard'
import { loadBriefings } from '../../../lib/contacts/meeting-briefings'

export const dynamic = 'force-dynamic'

const WINDOW_HOURS = 48

export default async function BriefingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { briefings, calendarConnected } = await loadBriefings(
    supabase,
    user.id,
    { windowHours: WINDOW_HOURS },
  )

  const subtitle = !calendarConnected
    ? 'Connect Google Calendar to start generating pre-meeting briefings.'
    : briefings.length === 0
      ? `No meetings on the calendar in the next ${WINDOW_HOURS} hours.`
      : `${briefings.length} meeting${briefings.length === 1 ? '' : 's'} in the next ${WINDOW_HOURS} hours — walk in prepared.`

  return (
    <div className="space-y-8 animate-fade-up">
      <PageHeader
        eyebrow="Pre-meeting"
        title="Meeting briefings"
        subtitle={subtitle}
      />

      {!calendarConnected ? (
        <EmptyState
          title="No calendar connected"
          body="Pre-meeting briefings need your Google Calendar — so AIEA knows who you're meeting with and when."
          action={
            <Link
              href="/settings"
              className="inline-flex items-center gap-1.5 rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white"
            >
              Connect Google Calendar →
            </Link>
          }
        />
      ) : briefings.length === 0 ? (
        <EmptyState
          title="No meetings ahead"
          body={`Nothing scheduled in the next ${WINDOW_HOURS} hours. Briefings appear here as meetings get added to your calendar.`}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {briefings.map((b) => (
            <MeetingBriefingCard key={b.event_id} briefing={b} variant="list" />
          ))}
        </div>
      )}
    </div>
  )
}
