import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '../../../../lib/supabase/server'
import { PageViewTracker } from '../../../../components/PageViewTracker'
import { PersonalDetailsEditor } from '../../../../components/PersonalDetailsEditor'
import { QuickAddInteraction } from '../../../../components/QuickAddInteraction'
import { InteractionTimeline } from '../../../../components/InteractionTimeline'
import { MeetingPrepBrief } from '../../../../components/MeetingPrepBrief'
import { RelationshipHealthBar } from '../../../../components/RelationshipHealth'
import { contactName, formatRelative, formatPhone } from '../../../../lib/format'
import type {
  Commitment,
  Contact,
  Interaction,
} from '../../../../lib/types'

export const dynamic = 'force-dynamic'

type CalendarEventRow = {
  id: string
  title: string | null
  start_at: string
  end_at: string | null
  location: string | null
  conference_url: string | null
  html_link: string | null
  attendees: unknown
}

type MessageRow = {
  id: string
  channel: string
  direction: 'inbound' | 'outbound' | null
  sender: string | null
  recipient: string | null
  subject: string | null
  snippet: string | null
  thread_id: string | null
  external_url: string | null
  sent_at: string
}

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // The contact profile is the single pane of glass — pull every signal that
  // links back to this contact: interactions, commitments, calendar events,
  // and unified-inbox messages. Calendar/messages probes tolerate a missing
  // table (per-user setup may not have them yet) so the page never 500s.
  const nowIso = new Date().toISOString()
  const [
    { data: contactData },
    ixRes,
    comRes,
    upcomingEventsRes,
    pastEventsRes,
    messagesRes,
  ] = await Promise.all([
    supabase.from('contacts').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('interactions')
      .select('*')
      .eq('contact_id', id)
      .order('occurred_at', { ascending: false })
      .limit(50),
    supabase
      .from('commitments')
      .select('*')
      .eq('contact_id', id)
      .order('due_at', { ascending: true, nullsFirst: false }),
    supabase
      .from('calendar_events')
      .select(
        'id, title, start_at, end_at, location, conference_url, html_link, attendees',
      )
      .eq('contact_id', id)
      .gte('start_at', nowIso)
      .order('start_at', { ascending: true })
      .limit(10),
    supabase
      .from('calendar_events')
      .select('id, title, start_at, end_at')
      .eq('contact_id', id)
      .lt('start_at', nowIso)
      .order('start_at', { ascending: false })
      .limit(1),
    supabase
      .from('messages')
      .select(
        'id, channel, direction, sender, recipient, subject, snippet, thread_id, external_url, sent_at',
      )
      .eq('contact_id', id)
      .eq('is_archived', false)
      .order('sent_at', { ascending: false })
      .limit(20),
  ])

  const contact = contactData as Contact | null
  if (!contact) notFound()
  const displayName = contactName(contact)

  const interactions = (ixRes.data ?? []) as Interaction[]
  const commitments = (comRes.data ?? []) as Commitment[]
  const openCommitments = commitments.filter((c) => c.status === 'open')
  const myOpen = openCommitments.filter((c) => c.owner === 'me')
  const theirOpen = openCommitments.filter((c) => c.owner === 'them')
  const upcomingMeetings = (
    upcomingEventsRes.error ? [] : (upcomingEventsRes.data ?? [])
  ) as CalendarEventRow[]
  const lastMeeting = (
    pastEventsRes.error
      ? []
      : ((pastEventsRes.data ?? []) as Pick<
          CalendarEventRow,
          'id' | 'title' | 'start_at' | 'end_at'
        >[])
  )[0]
  const messages = (
    messagesRes.error ? [] : (messagesRes.data ?? [])
  ) as MessageRow[]

  // Last contact across every signal we know about. interactions covers
  // logged calls / extracted emails; messages covers raw inbox; calendar
  // covers past meetings. Take the most recent.
  const lastContactCandidates: number[] = []
  if (contact.last_interaction_at) {
    lastContactCandidates.push(new Date(contact.last_interaction_at).getTime())
  }
  if (interactions[0]) {
    lastContactCandidates.push(new Date(interactions[0].occurred_at).getTime())
  }
  if (messages[0]) {
    lastContactCandidates.push(new Date(messages[0].sent_at).getTime())
  }
  if (lastMeeting) {
    lastContactCandidates.push(new Date(lastMeeting.start_at).getTime())
  }
  const lastContactAt = lastContactCandidates.length
    ? new Date(Math.max(...lastContactCandidates)).toISOString()
    : null

  const nextMeeting = upcomingMeetings[0] ?? null

  const followUp = contact.next_follow_up
    ? new Date(contact.next_follow_up)
    : null
  const followUpDays = followUp
    ? Math.ceil((followUp.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
        <PageViewTracker eventType="contact_viewed" contactId={contact.id} />
        <Link
          href="/"
          className="inline-block text-sm text-zinc-500 hover:text-zinc-200"
        >
          ← Back
        </Link>

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="bg-gradient-to-r from-indigo-300 via-violet-300 to-fuchsia-300 bg-clip-text text-3xl font-medium tracking-tight text-transparent">
              {displayName}
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              {[contact.title, contact.company].filter(Boolean).join(' · ') ||
                '—'}
            </p>
          </div>
          <QuickAddInteraction
            contactId={contact.id}
            contactName={displayName}
          />
        </header>

        {followUp && (
          <div className="rounded-xl border border-violet-500/40 bg-violet-500/10 p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-violet-300">
              Next follow-up
            </div>
            <div className="mt-1 text-base text-zinc-100">
              {followUp.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
              {followUpDays != null && (
                <span className="ml-2 text-sm text-zinc-400">
                  {followUpDays === 0
                    ? '(today)'
                    : followUpDays > 0
                      ? `(in ${followUpDays}d)`
                      : `(${Math.abs(followUpDays)}d overdue)`}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-3">
          <DarkCard className="md:col-span-1">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Contact info
            </h2>
            <dl className="space-y-2 text-sm">
              <Field label="Email" value={contact.email} mono />
              <Field label="Phone" value={formatPhone(contact.phone)} mono />
              <Field label="Company" value={contact.company} />
              <Field label="Title" value={contact.title} />
              <Field
                label="LinkedIn"
                value={
                  contact.linkedin ? (
                    <a
                      href={contact.linkedin}
                      target="_blank"
                      rel="noreferrer"
                      className="text-violet-400 hover:underline"
                    >
                      Profile
                    </a>
                  ) : null
                }
              />
              <Field
                label="Last contact"
                value={lastContactAt ? formatRelative(lastContactAt) : null}
              />
              <Field
                label="Next meeting"
                value={
                  nextMeeting
                    ? `${formatMeetingDate(nextMeeting.start_at)}${
                        nextMeeting.title ? ` · ${nextMeeting.title}` : ''
                      }`
                    : null
                }
              />
              <Field
                label="Tier"
                value={contact.tier ? `T${contact.tier}` : null}
              />
            </dl>
          </DarkCard>

          <div className="space-y-6 md:col-span-2">
            <DarkCard>
              <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Relationship health
              </h2>
              <RelationshipHealthBar
                contact={contact}
                interactions={interactions}
                commitments={commitments}
              />
            </DarkCard>

            <MeetingPrepBrief contactId={contact.id} />
          </div>
        </div>

        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
            Personal details
          </h2>
          <DarkCard>
            <PersonalDetailsEditor
              contactId={contact.id}
              initial={contact.personal_details}
            />
          </DarkCard>
        </section>

        {upcomingMeetings.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
              Upcoming meetings{' '}
              <span className="text-zinc-600">({upcomingMeetings.length})</span>
            </h2>
            <DarkCard>
              <ul className="divide-y divide-zinc-800">
                {upcomingMeetings.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-3 py-3 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-zinc-100">
                        {m.title || 'Untitled meeting'}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {formatMeetingDate(m.start_at)}
                        {m.location ? ` · ${m.location}` : ''}
                      </div>
                    </div>
                    {m.conference_url && (
                      <a
                        href={m.conference_url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 py-1 text-xs text-violet-200 hover:border-violet-400"
                      >
                        Join
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </DarkCard>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
            Open commitments{' '}
            <span className="text-zinc-600">({openCommitments.length})</span>
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <DarkCard>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-violet-300">
                You owe {displayName}{' '}
                <span className="text-zinc-600">({myOpen.length})</span>
              </h3>
              {myOpen.length === 0 ? (
                <p className="text-sm text-zinc-500">Nothing on your plate.</p>
              ) : (
                <ul className="divide-y divide-zinc-800">
                  {myOpen.map((c) => (
                    <CommitmentLi key={c.id} c={c} />
                  ))}
                </ul>
              )}
            </DarkCard>
            <DarkCard>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fuchsia-300">
                {displayName} owes you{' '}
                <span className="text-zinc-600">({theirOpen.length})</span>
              </h3>
              {theirOpen.length === 0 ? (
                <p className="text-sm text-zinc-500">Nothing pending.</p>
              ) : (
                <ul className="divide-y divide-zinc-800">
                  {theirOpen.map((c) => (
                    <CommitmentLi key={c.id} c={c} />
                  ))}
                </ul>
              )}
            </DarkCard>
          </div>
        </section>

        {messages.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
              Recent messages{' '}
              <span className="text-zinc-600">({messages.length})</span>
            </h2>
            <DarkCard>
              <ul className="divide-y divide-zinc-800">
                {messages.map((m) => (
                  <li key={m.id} className="py-3 text-sm">
                    <div className="flex items-baseline justify-between gap-3 text-xs text-zinc-500">
                      <span className="font-medium uppercase tracking-wide text-zinc-400">
                        {m.channel}
                        {m.direction ? ` · ${m.direction}` : ''}
                      </span>
                      <span>{formatRelative(m.sent_at)}</span>
                    </div>
                    {m.subject && (
                      <div className="mt-1 truncate text-zinc-100">
                        {m.subject}
                      </div>
                    )}
                    {m.snippet && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-zinc-400">
                        {m.snippet}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </DarkCard>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
            Interaction timeline{' '}
            <span className="text-zinc-600">({interactions.length})</span>
          </h2>
          <DarkCard>
            <InteractionTimeline interactions={interactions} />
          </DarkCard>
        </section>
      </div>
    </div>
  )
}

function DarkCard({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={`rounded-xl border border-zinc-800 bg-zinc-900 p-5 ${className}`}
    >
      {children}
    </div>
  )
}

function Field({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-zinc-500">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-zinc-200 ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value || <span className="text-zinc-600">—</span>}
      </dd>
    </div>
  )
}

function CommitmentLi({ c }: { c: Commitment }) {
  const overdue = c.due_at != null && new Date(c.due_at) < new Date()
  return (
    <li className="py-3 text-sm">
      <div className="truncate text-zinc-100">{c.description}</div>
      {c.due_at && (
        <div
          className={`mt-0.5 text-xs ${overdue ? 'text-red-400' : 'text-zinc-500'}`}
        >
          due {new Date(c.due_at).toLocaleDateString()}
        </div>
      )}
    </li>
  )
}

function formatMeetingDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const after = new Date(tomorrow)
  after.setDate(after.getDate() + 1)

  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  if (d >= today && d < tomorrow) return `Today, ${time}`
  if (d >= tomorrow && d < after) return `Tomorrow, ${time}`
  return `${d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })}, ${time}`
}
