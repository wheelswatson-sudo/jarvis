import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '../../../../lib/supabase/server'
import { PageViewTracker } from '../../../../components/PageViewTracker'
import { PersonalDetailsEditor } from '../../../../components/PersonalDetailsEditor'
import { PipelineSelector } from '../../../../components/PipelineSelector'
import { QuickAddInteraction } from '../../../../components/QuickAddInteraction'
import { InteractionTimeline } from '../../../../components/InteractionTimeline'
import { MeetingPrepBrief } from '../../../../components/MeetingPrepBrief'
import { RelationshipHealthBar } from '../../../../components/RelationshipHealth'
import { CadenceBadge } from '../../../../components/CadenceBadge'
import { Card, SectionHeader } from '../../../../components/cards'
import { TierSelector } from '../../../../components/ContactEditor'
import {
  contactName,
  formatRelative,
  formatPhone,
  pipelineStageColor,
} from '../../../../lib/format'
import { PIPELINE_STAGE_LABELS } from '../../../../lib/types'
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

function initials(c: Contact): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) {
    return parts
      .map((p) => p[0]!)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  }
  if (c.email) return c.email[0]!.toUpperCase()
  return '·'
}

const CHANNEL_TONE: Record<string, string> = {
  email: 'bg-indigo-500/10 text-indigo-200 ring-indigo-500/30',
  imessage: 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/30',
  sms: 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/30',
  slack: 'bg-violet-500/10 text-violet-200 ring-violet-500/30',
  telegram: 'bg-sky-500/10 text-sky-200 ring-sky-500/30',
  linkedin: 'bg-indigo-500/10 text-indigo-200 ring-indigo-500/30',
  facebook: 'bg-blue-500/10 text-blue-200 ring-blue-500/30',
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
    <div className="space-y-8 animate-fade-up">
      <PageViewTracker eventType="contact_viewed" contactId={contact.id} />

      <Link
        href="/contacts"
        className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-200"
      >
        <span aria-hidden="true">←</span> Back to contacts
      </Link>

      {/* Hero */}
      <header className="relative overflow-hidden rounded-2xl aiea-glass-strong p-6 sm:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.07] via-violet-500/[0.04] to-fuchsia-500/[0.07]"
        />
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-4">
            <span
              aria-hidden="true"
              className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/30 via-violet-500/25 to-fuchsia-500/30 text-base font-semibold text-white ring-1 ring-inset ring-white/15"
            >
              {initials(contact)}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-3xl font-semibold tracking-tight aiea-gradient-text sm:text-4xl">
                  {displayName}
                </h1>
                {contact.pipeline_stage && (
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide ${pipelineStageColor(contact.pipeline_stage)}`}
                  >
                    {PIPELINE_STAGE_LABELS[contact.pipeline_stage]}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-sm text-zinc-400">
                {[contact.title, contact.company].filter(Boolean).join(' · ') ||
                  'No role on file'}
              </p>
              {lastContactAt && (
                <p className="mt-1 text-xs text-zinc-500">
                  Last contact {formatRelative(lastContactAt)}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <TierSelector contact={contact} />
                <CadenceBadge
                  tier={contact.tier}
                  lastInteractionAt={lastContactAt}
                />
              </div>
            </div>
          </div>
          <QuickAddInteraction
            contactId={contact.id}
            contactName={displayName}
          />
        </div>
      </header>

      {followUp && (
        <div className="relative overflow-hidden rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-500/[0.12] via-violet-500/[0.06] to-fuchsia-500/[0.10] p-5">
          <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-200">
            Next follow-up
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className="text-lg font-medium text-zinc-50">
              {followUp.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
            </span>
            {followUpDays != null && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  followUpDays < 0
                    ? 'bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-500/30'
                    : followUpDays === 0
                      ? 'bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30'
                      : 'bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-500/30'
                }`}
              >
                {followUpDays === 0
                  ? 'today'
                  : followUpDays > 0
                    ? `in ${followUpDays}d`
                    : `${Math.abs(followUpDays)}d overdue`}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-1">
          <h2 className="mb-4 text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
            Contact info
          </h2>
          <dl className="space-y-3 text-sm">
            <Field
              label="Email"
              value={
                contact.email ? (
                  <a
                    href={`mailto:${contact.email}`}
                    className="text-violet-300 transition-colors hover:text-violet-200 hover:underline"
                  >
                    {contact.email}
                  </a>
                ) : null
              }
              mono
            />
            <Field
              label="Phone"
              value={
                contact.phone ? (
                  <a
                    href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}
                    className="text-violet-300 transition-colors hover:text-violet-200 hover:underline"
                  >
                    {formatPhone(contact.phone)}
                  </a>
                ) : null
              }
              mono
            />
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
                    className="text-violet-300 transition-colors hover:text-violet-200 hover:underline"
                  >
                    Profile ↗
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
          </dl>
        </Card>

        <div className="space-y-6 md:col-span-2">
          <Card>
            <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
              Relationship health
            </h2>
            <RelationshipHealthBar
              contact={contact}
              interactions={interactions}
              commitments={commitments}
            />
          </Card>

          <MeetingPrepBrief contactId={contact.id} />
        </div>
      </div>

      <section>
        <SectionHeader
          eyebrow="Pipeline"
          title="Stage"
          subtitle="Where this relationship sits in your funnel."
        />
        <Card>
          <PipelineSelector contact={contact} />
        </Card>
      </section>

      <section>
        <SectionHeader
          eyebrow="Personal"
          title="Personal details"
          subtitle="The non-obvious context that sharpens every conversation."
        />
        <Card>
          <PersonalDetailsEditor
            contactId={contact.id}
            initial={contact.personal_details}
          />
        </Card>
      </section>

      {upcomingMeetings.length > 0 && (
        <section>
          <SectionHeader
            eyebrow="Calendar"
            title={
              <>
                Upcoming meetings{' '}
                <span className="text-zinc-600 font-normal">
                  ({upcomingMeetings.length})
                </span>
              </>
            }
          />
          <Card>
            <ul className="divide-y divide-white/[0.05]">
              {upcomingMeetings.map((m) => (
                <li
                  key={m.id}
                  className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-3 text-sm transition-colors first:pt-0 last:pb-0 hover:bg-white/[0.02]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-zinc-100">
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
                      className="shrink-0 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-200 transition-colors hover:border-violet-400/60 hover:bg-violet-500/20 hover:text-violet-100"
                    >
                      Join →
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section>
        <SectionHeader
          eyebrow="Loop"
          title={
            <>
              Open commitments{' '}
              <span className="text-zinc-600 font-normal">
                ({openCommitments.length})
              </span>
            </>
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <h3 className="mb-3 inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-indigo-300">
              <span className="h-1 w-1 rounded-full bg-indigo-400" />
              You owe {displayName}{' '}
              <span className="text-zinc-600">({myOpen.length})</span>
            </h3>
            {myOpen.length === 0 ? (
              <p className="text-sm text-zinc-500">Nothing on your plate.</p>
            ) : (
              <ul className="divide-y divide-white/[0.05]">
                {myOpen.map((c) => (
                  <CommitmentLi key={c.id} c={c} />
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h3 className="mb-3 inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-fuchsia-300">
              <span className="h-1 w-1 rounded-full bg-fuchsia-400" />
              {displayName} owes you{' '}
              <span className="text-zinc-600">({theirOpen.length})</span>
            </h3>
            {theirOpen.length === 0 ? (
              <p className="text-sm text-zinc-500">Nothing pending.</p>
            ) : (
              <ul className="divide-y divide-white/[0.05]">
                {theirOpen.map((c) => (
                  <CommitmentLi key={c.id} c={c} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>

      {messages.length > 0 && (
        <section>
          <SectionHeader
            eyebrow="Messages"
            title={
              <>
                Recent messages{' '}
                <span className="text-zinc-600 font-normal">
                  ({messages.length})
                </span>
              </>
            }
          />
          <Card>
            <ul className="divide-y divide-white/[0.05]">
              {messages.map((m) => {
                const channelCls =
                  CHANNEL_TONE[m.channel] ??
                  'bg-white/[0.04] text-zinc-300 ring-white/10'
                return (
                  <li
                    key={m.id}
                    className="-mx-2 rounded-lg px-2 py-3 text-sm transition-colors first:pt-0 last:pb-0 hover:bg-white/[0.02]"
                  >
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${channelCls}`}
                      >
                        {m.channel}
                        {m.direction ? ` · ${m.direction}` : ''}
                      </span>
                      <span className="text-zinc-500 tabular-nums">
                        {formatRelative(m.sent_at)}
                      </span>
                    </div>
                    {m.subject && (
                      <div className="mt-1.5 truncate font-medium text-zinc-100">
                        {m.subject}
                      </div>
                    )}
                    {m.snippet && (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">
                        {m.snippet}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          </Card>
        </section>
      )}

      <section>
        <SectionHeader
          eyebrow="History"
          title={
            <>
              Interaction timeline{' '}
              <span className="text-zinc-600 font-normal">
                ({interactions.length})
              </span>
            </>
          }
        />
        <Card>
          <InteractionTimeline interactions={interactions} />
        </Card>
      </section>
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
      <dt className="shrink-0 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
        {label}
      </dt>
      <dd
        className={`min-w-0 truncate text-right text-zinc-200 ${mono ? 'font-mono text-xs' : 'text-sm'}`}
      >
        {value || <span className="text-zinc-600">—</span>}
      </dd>
    </div>
  )
}

function CommitmentLi({ c }: { c: Commitment }) {
  const overdue = c.due_at != null && new Date(c.due_at) < new Date()
  return (
    <li className="py-3 text-sm first:pt-0 last:pb-0">
      <div className="truncate text-zinc-100">{c.description}</div>
      {c.due_at && (
        <div
          className={`mt-0.5 text-xs ${overdue ? 'text-rose-300' : 'text-zinc-500'}`}
        >
          due {new Date(c.due_at).toLocaleDateString()}
          {overdue && (
            <span className="ml-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ring-rose-500/30">
              overdue
            </span>
          )}
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
