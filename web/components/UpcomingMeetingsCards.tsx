import Link from 'next/link'
import { tierColor, tierLabel, formatRelative } from '../lib/format'
import type {
  MeetingCard,
  AttendeeBrief,
} from '../lib/contacts/upcoming-meetings'

const TREND_TONE = {
  warming: {
    label: 'warming',
    cls: 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30',
  },
  stable: {
    label: 'stable',
    cls: 'text-zinc-300 bg-white/[0.04] ring-white/10',
  },
  cooling: {
    label: 'cooling',
    cls: 'text-amber-300 bg-amber-500/10 ring-amber-500/30',
  },
  dormant: {
    label: 'dormant',
    cls: 'text-rose-300 bg-rose-500/10 ring-rose-500/30',
  },
} as const satisfies Record<
  NonNullable<AttendeeBrief['trend']>,
  { label: string; cls: string }
>

export function UpcomingMeetingsCards({
  meetings,
  calendarConnected,
}: {
  meetings: MeetingCard[]
  calendarConnected: boolean
}) {
  if (!calendarConnected) {
    return (
      <div className="rounded-2xl aiea-glass p-6 text-center text-sm">
        <p className="text-zinc-300">No calendar connected.</p>
        <p className="mt-1 text-xs text-zinc-500">
          Pre-meeting briefs need your calendar.
        </p>
        <Link
          href="/settings"
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg aiea-cta px-3.5 py-1.5 text-xs font-medium text-white"
        >
          Connect Google Calendar →
        </Link>
      </div>
    )
  }

  if (meetings.length === 0) {
    return (
      <div className="rounded-2xl aiea-glass p-5 text-sm text-zinc-500">
        No meetings in the next 24 hours.
      </div>
    )
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {meetings.map((m) => (
        <MeetingCardView key={m.id} meeting={m} />
      ))}
    </div>
  )
}

function MeetingCardView({ meeting }: { meeting: MeetingCard }) {
  return (
    <article className="relative overflow-hidden rounded-2xl aiea-glass p-4">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-12 -top-12 h-28 w-28 rounded-full bg-gradient-to-br from-indigo-500/15 via-violet-500/10 to-fuchsia-500/15 opacity-60 blur-2xl"
      />
      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium text-zinc-100">
              {meeting.title || 'Untitled meeting'}
            </h3>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              {formatMeetingTime(meeting.start_at, meeting.end_at)}
              {meeting.location ? ` · ${meeting.location}` : ''}
            </p>
          </div>
          {meeting.conference_url && (
            <a
              href={meeting.conference_url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-md border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-medium text-violet-200 transition-colors hover:border-violet-400/60 hover:bg-violet-500/20"
            >
              Join →
            </a>
          )}
        </div>

        {meeting.attendees.length === 0 ? (
          <p className="mt-3 text-[11px] text-zinc-500">
            No known contacts on this meeting.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {meeting.attendees.map((a) => (
              <AttendeeRow key={a.contact_id} attendee={a} />
            ))}
          </ul>
        )}
      </div>
    </article>
  )
}

function AttendeeRow({ attendee }: { attendee: AttendeeBrief }) {
  const trend = attendee.trend ? TREND_TONE[attendee.trend] : null
  return (
    <li className="rounded-lg border border-white/[0.06] bg-white/[0.015] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={`/contacts/${attendee.contact_id}`}
          className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100 transition-colors hover:text-violet-200"
        >
          {attendee.name}
        </Link>
        <div className="flex shrink-0 items-center gap-1.5">
          {attendee.tier != null && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide ${tierColor(attendee.tier)}`}
            >
              {tierLabel(attendee.tier)}
            </span>
          )}
          {trend && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${trend.cls}`}
            >
              {trend.label}
            </span>
          )}
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
        <span>
          last contact{' '}
          <span className="text-zinc-400">
            {formatRelative(attendee.last_interaction_at)}
          </span>
        </span>
        {attendee.open_commitments > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-amber-300">
              {attendee.open_commitments} open commitment
              {attendee.open_commitments === 1 ? '' : 's'}
            </span>
          </>
        )}
      </div>
    </li>
  )
}

function formatMeetingTime(startIso: string, endIso: string | null): string {
  const start = new Date(startIso)
  if (Number.isNaN(start.getTime())) return '—'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const after = new Date(tomorrow)
  after.setDate(after.getDate() + 1)

  const startTime = start.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  const endTime = endIso
    ? new Date(endIso).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      })
    : null
  const range = endTime ? `${startTime}–${endTime}` : startTime

  if (start >= today && start < tomorrow) return `Today, ${range}`
  if (start >= tomorrow && start < after) return `Tomorrow, ${range}`
  return `${start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })}, ${range}`
}
