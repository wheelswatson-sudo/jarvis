import Link from 'next/link'
import { createClient } from '../../../lib/supabase/server'
import { IntelligencePanel } from '../../../components/IntelligencePanel'
import { RelationshipAlerts } from '../../../components/RelationshipAlerts'
import { TranscriptImporter } from '../../../components/TranscriptImporter'
import {
  CommitmentTracker,
  type EnrichedCommitment,
} from '../../../components/CommitmentTracker'
import { EscalatedCommitments } from '../../../components/EscalatedCommitments'
import { UpcomingMeetingsCards } from '../../../components/UpcomingMeetingsCards'
import { loadUpcomingMeetings } from '../../../lib/contacts/upcoming-meetings'
import { computeHealth } from '../../../components/RelationshipHealth'
import { contactName } from '../../../lib/format'
import type { Commitment, Contact, Interaction } from '../../../lib/types'

export const dynamic = 'force-dynamic'

const ATTENTION_LIMIT = 5

export default async function DashboardPage() {
  const supabase = await createClient()
  const since30 = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [contactsRes, commitmentsRes, interactionsRes, recentRes, meetings] =
    await Promise.all([
      supabase.from('contacts').select('*').limit(2000),
      supabase.from('commitments').select('*'),
      supabase
        .from('interactions')
        .select('id, contact_id, summary, occurred_at, type, channel')
        .gte('occurred_at', since30)
        .order('occurred_at', { ascending: false })
        .limit(2000),
      supabase
        .from('interactions')
        .select('id, contact_id, summary, occurred_at')
        .order('occurred_at', { ascending: false })
        .limit(60),
      user
        ? loadUpcomingMeetings(supabase, user.id)
        : Promise.resolve({ meetings: [], calendarConnected: false }),
    ])

  const contacts = (contactsRes.data ?? []) as Contact[]
  const commitments = (commitmentsRes.data ?? []) as Commitment[]
  const recentInteractions = (interactionsRes.data ?? []) as Pick<
    Interaction,
    'id' | 'contact_id' | 'summary' | 'occurred_at' | 'type' | 'channel'
  >[]
  const allRecent = (recentRes.data ?? []) as Pick<
    Interaction,
    'id' | 'contact_id' | 'summary' | 'occurred_at'
  >[]

  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const within = (iso: string | null | undefined, days: number) =>
    iso != null && now - new Date(iso).getTime() < days * day

  const active = contacts.filter((c) => within(c.last_interaction_at, 30)).length
  const cooling = contacts.filter(
    (c) =>
      within(c.last_interaction_at, 90) && !within(c.last_interaction_at, 30),
  ).length
  const dormant = contacts.filter(
    (c) => !within(c.last_interaction_at, 90),
  ).length

  const openCommitments = commitments.filter((c) => c.status === 'open')
  const overdueCommitments = openCommitments.filter(
    (c) => c.due_at && new Date(c.due_at).getTime() < now,
  )
  const completed30 = commitments.filter(
    (c) =>
      c.status === 'done' &&
      c.completed_at &&
      now - new Date(c.completed_at).getTime() < 30 * day,
  )
  const due30 = commitments.filter(
    (c) =>
      c.due_at &&
      Math.abs(now - new Date(c.due_at).getTime()) < 30 * day,
  )
  const compliance =
    completed30.length + overdueCommitments.length === 0
      ? null
      : completed30.length /
        Math.max(1, completed30.length + overdueCommitments.length)

  // 30-day interaction frequency by week.
  const weeks = [0, 1, 2, 3].map((i) => {
    const start = now - (i + 1) * 7 * day
    const end = now - i * 7 * day
    const count = recentInteractions.filter((it) => {
      const t = new Date(it.occurred_at).getTime()
      return t >= start && t < end
    }).length
    return { weekIdx: 3 - i, count }
  })
  const maxWeek = Math.max(1, ...weeks.map((w) => w.count))

  // Top 5 needing attention: tier 1/2 with low health.
  const needsAttention = contacts
    .filter((c) => c.tier === 1 || c.tier === 2)
    .map((c) => {
      const ix = recentInteractions.filter((i) => i.contact_id === c.id)
      const com = commitments.filter((co) => co.contact_id === c.id)
      const h = computeHealth(c, ix as unknown as Interaction[], com)
      return { contact: c, score: h.score, label: h.label }
    })
    .filter((row) => row.score < 0.5)
    .sort((a, b) => a.score - b.score)
    .slice(0, ATTENTION_LIMIT)

  const nameById = new Map(contacts.map((c) => [c.id, contactName(c)]))
  const enrichedCommitments: EnrichedCommitment[] = commitments
    .filter((c) => c.status === 'open')
    .map((c) => ({
      ...c,
      contact_name: c.contact_id ? (nameById.get(c.contact_id) ?? null) : null,
    }))

  return (
    <div className="space-y-10 animate-fade-up">
      <header>
        <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/25 bg-violet-500/[0.08] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-violet-200">
          <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400" />
          Dashboard
        </div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight aiea-gradient-text sm:text-4xl">
          Relationship intelligence
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400 sm:text-base">
          {contacts.length} contacts · {active} active · {cooling} cooling ·{' '}
          {dormant} dormant
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 aiea-stagger">
        <Metric label="Active (30d)" value={active.toString()} />
        <Metric label="Cooling" value={cooling.toString()} accent />
        <Metric
          label="Open commitments"
          value={openCommitments.length.toString()}
          hint={`${overdueCommitments.length} overdue`}
        />
        <Metric
          label="Compliance (30d)"
          value={
            compliance == null
              ? '—'
              : `${Math.round(compliance * 100)}%`
          }
          hint={`${completed30.length}/${due30.length} on time`}
        />
      </div>

      <section>
        <SectionHeader
          title="Quick actions"
          subtitle="Capture a meeting, log an interaction, scan a transcript."
        />
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/commitments"
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3.5 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-violet-400/40 hover:text-white"
          >
            View all commitments →
          </Link>
          <Link
            href="/contacts/import"
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3.5 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-violet-400/40 hover:text-white"
          >
            Import contacts →
          </Link>
        </div>
        <div className="mt-3">
          <TranscriptImporter />
        </div>
      </section>

      <section>
        <SectionHeader
          title="Today's meetings"
          subtitle="Upcoming in the next 24 hours, with relationship context."
        />
        <UpcomingMeetingsCards
          meetings={meetings.meetings}
          calendarConnected={meetings.calendarConnected}
        />
      </section>

      <section>
        <SectionHeader
          title="Needs your attention"
          subtitle="Decay alerts, overdue items, and follow-ups due now."
        />
        <RelationshipAlerts
          contacts={contacts}
          commitments={commitments}
          interactions={allRecent}
        />
      </section>

      <IntelligencePanel />

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <SectionHeader
            title="Top relationships needing attention"
            subtitle={`Tier 1 & 2 contacts with declining health (${needsAttention.length}).`}
          />
          <DashCard>
            {needsAttention.length === 0 ? (
              <p className="text-sm text-zinc-500">
                All inner-circle relationships are healthy.
              </p>
            ) : (
              <ul className="divide-y divide-white/[0.05]">
                {needsAttention.map((row) => {
                  const days =
                    row.contact.last_interaction_at != null
                      ? Math.floor(
                          (now -
                            new Date(
                              row.contact.last_interaction_at,
                            ).getTime()) /
                            day,
                        )
                      : null
                  return (
                    <li key={row.contact.id}>
                      <Link
                        href={`/contacts/${row.contact.id}`}
                        className="group -mx-2 flex items-baseline justify-between gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-white/[0.025]"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-zinc-100 transition-colors group-hover:text-white">
                            {contactName(row.contact)}
                          </div>
                          <div className="mt-0.5 text-xs text-zinc-500">
                            T{row.contact.tier} ·{' '}
                            {days != null ? `${days}d ago` : 'never'} ·{' '}
                            {row.label}
                          </div>
                        </div>
                        <span className="tabular-nums text-xs font-medium text-zinc-400 transition-colors group-hover:text-zinc-200">
                          {Math.round(row.score * 100)}%
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </DashCard>
        </section>

        <section>
          <SectionHeader
            title="Interaction frequency"
            subtitle="Last 4 weeks."
          />
          <DashCard>
            <div className="flex h-32 items-end justify-between gap-2">
              {weeks
                .slice()
                .sort((a, b) => a.weekIdx - b.weekIdx)
                .map((w) => {
                  const h = Math.max(2, Math.round((w.count / maxWeek) * 100))
                  const label =
                    w.weekIdx === 3
                      ? 'this wk'
                      : w.weekIdx === 2
                        ? '−1 wk'
                        : w.weekIdx === 1
                          ? '−2 wk'
                          : '−3 wk'
                  return (
                    <div
                      key={w.weekIdx}
                      className="flex flex-1 flex-col items-center gap-2"
                    >
                      <div className="flex h-full w-full items-end">
                        <div
                          className="w-full rounded-t-md bg-gradient-to-t from-indigo-500 via-violet-500 to-fuchsia-500 shadow-[0_0_12px_rgba(139,92,246,0.35)] transition-[height] duration-700"
                          style={{ height: `${h}%` }}
                        />
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                        {label}
                      </div>
                      <div className="text-xs font-medium tabular-nums text-zinc-200">
                        {w.count}
                      </div>
                    </div>
                  )
                })}
            </div>
          </DashCard>
        </section>
      </div>

      <section>
        <SectionHeader
          title="Commitments needing action"
          subtitle="Within 3 days of due, or overdue. Sorted by urgency."
        />
        <EscalatedCommitments commitments={enrichedCommitments} />
      </section>

      <section>
        <SectionHeader
          title="Open commitments"
          subtitle={`${enrichedCommitments.length} open across your network.`}
        />
        <CommitmentTracker commitments={enrichedCommitments} />
      </section>
    </div>
  )
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-medium tracking-tight text-zinc-100 sm:text-xl">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-1 max-w-xl text-sm text-zinc-400">{subtitle}</p>
      )}
    </div>
  )
}

function DashCard({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-2xl aiea-glass p-5 ${className}`}>
      {children}
    </div>
  )
}

function Metric({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
}) {
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl aiea-glass aiea-lift p-5 ${
        accent ? 'ring-1 ring-inset ring-amber-500/30' : ''
      }`}
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-[0.08] blur-2xl transition-opacity duration-300 group-hover:opacity-[0.18] ${
          accent
            ? 'bg-gradient-to-br from-amber-500 to-rose-500'
            : 'bg-gradient-to-br from-violet-500 to-fuchsia-500'
        }`}
      />
      <div className="relative text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </div>
      <div className="relative mt-3 text-3xl font-semibold tracking-tight tabular-nums text-zinc-50">
        {value}
      </div>
      {hint && (
        <div className="relative mt-1.5 text-[11px] text-zinc-500">{hint}</div>
      )}
    </div>
  )
}
