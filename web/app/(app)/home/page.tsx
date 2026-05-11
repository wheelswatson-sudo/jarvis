import Link from 'next/link'
import { createClient } from '../../../lib/supabase/server'
import {
  Card,
  EmptyState,
  MetricCard,
  PageHeader,
  SectionHeader,
} from '../../../components/cards'
import { HelpDot } from '../../../components/Tooltip'
import { Greeting } from '../../../components/Greeting'
import { ForgottenLoops } from '../../../components/ForgottenLoops'
import { IntelligencePanel } from '../../../components/IntelligencePanel'
import { contactName, formatRelative } from '../../../lib/format'
import { NETWORK_HEALTH_HELP } from '../../../lib/glossary'
import type { Commitment, Contact } from '../../../lib/types'
import { APOLLO_PROVIDER } from '../../../lib/apollo'
import {
  loadBriefings,
  type Briefing,
  type MatchedAttendee,
} from '../../../lib/contacts/meeting-briefings'
import { findForgottenLoops, type ForgottenLoop } from '../../../lib/intelligence/forgotten-loops'
import {
  findSentimentShifts,
  type SentimentShift,
} from '../../../lib/intelligence/sentiment-shifts'
import {
  findUpcomingMilestones,
  type UpcomingMilestone,
} from '../../../lib/intelligence/milestone-radar'
import {
  findRecentLifeEvents,
  type RecentLifeEvent,
} from '../../../lib/intelligence/recent-life-events'
import {
  findOwedToYou,
  type OwedToYou as OwedToYouItem,
} from '../../../lib/intelligence/owed-to-you'
import {
  findReciprocityFlags,
  type ReciprocityFlag,
} from '../../../lib/intelligence/reciprocity-flags'
import {
  findTopicWatchHits,
  type TopicWatchHit,
} from '../../../lib/intelligence/topic-watch'
import { SentimentShifts } from '../../../components/SentimentShifts'
import { MilestoneRadar } from '../../../components/MilestoneRadar'
import { RecentLifeEvents } from '../../../components/RecentLifeEvents'
import { OwedToYou } from '../../../components/OwedToYou'
import { ReciprocityFlags } from '../../../components/ReciprocityFlags'
import { TopicWatch } from '../../../components/TopicWatch'
import { getServiceClient } from '../../../lib/supabase/service'

export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE_DAYS = 30
const DORMANT_DAYS = 60
const TIER1_SILENT_DAYS = 30
const TIER2_SILENT_DAYS = 45
const HALFLIFE_WARN_DAYS = 3
const COMMITMENT_DUE_SOON_DAYS = 3
const ACTION_LIMIT = 8
const ACTIVITY_LIMIT = 8
const ACTIVITY_WINDOW_DAYS = 14
const GET_STARTED_THRESHOLD = 5

type ActionTone = 'rose' | 'amber' | 'violet' | 'indigo'

type ActionItem = {
  key: string
  href: string
  primary: string
  secondary: string
  urgency: number
  tone: ActionTone
}

type ActivityKind = 'email' | 'imessage' | 'sms' | 'meeting' | 'task'

type ActivityRow = {
  key: string
  ts: string
  kind: ActivityKind
  primary: string
  secondary: string
  href?: string
}

type CommitmentForList = Pick<
  Commitment,
  'id' | 'contact_id' | 'due_at' | 'status' | 'description'
>

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / DAY_MS)
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((t - Date.now()) / DAY_MS)
}

// Higher score = more urgent. Bands (top wins) with linear ordering inside:
//   100+  overdue commitment (linear in days overdue)
//    80+  half-life elapsed (linear in days past)
//    70-  half-life expiring within HALFLIFE_WARN_DAYS
//    60+  T1 silent past TIER1_SILENT_DAYS
//    50-  commitment due within COMMITMENT_DUE_SOON_DAYS
//    40+  T2 silent past TIER2_SILENT_DAYS
//
// Each contact appears at most once in the final list — we collect all
// candidates, then keep the highest-urgency one per contact. That keeps the
// list surfacing distinct relationships (a chatty contact with three commits
// and a stale half-life shouldn't crowd out a different cooling contact).
function buildActionList(
  contacts: Contact[],
  commitments: CommitmentForList[],
): ActionItem[] {
  const byId = new Map(contacts.map((c) => [c.id, c]))
  type Candidate = ActionItem & { contactId: string }
  const candidates: Candidate[] = []

  for (const com of commitments) {
    if (com.status !== 'open' || !com.due_at || !com.contact_id) continue
    const contact = byId.get(com.contact_id)
    if (!contact) continue
    const dUntil = daysUntil(com.due_at)
    if (dUntil == null) continue
    const name = contactName(contact)
    if (dUntil < 0) {
      const overdue = -dUntil
      candidates.push({
        contactId: contact.id,
        key: `com-${com.id}`,
        href: `/contacts/${contact.id}`,
        primary: `Overdue: ${com.description}`,
        secondary: `${name} — ${overdue}d overdue`,
        urgency: 100 + overdue,
        tone: 'rose',
      })
    } else if (dUntil <= COMMITMENT_DUE_SOON_DAYS) {
      const when =
        dUntil === 0 ? 'today' : dUntil === 1 ? 'tomorrow' : `in ${dUntil}d`
      candidates.push({
        contactId: contact.id,
        key: `com-${com.id}`,
        href: `/contacts/${contact.id}`,
        primary: `Due ${when}: ${com.description}`,
        secondary: name,
        urgency: 50 + (COMMITMENT_DUE_SOON_DAYS - dUntil),
        tone: 'violet',
      })
    }
  }

  for (const c of contacts) {
    const dSince = daysSince(c.last_interaction_at)
    if (dSince == null) continue
    const name = contactName(c)

    if (typeof c.half_life_days === 'number' && c.half_life_days > 0) {
      const past = dSince - c.half_life_days
      if (past >= 0) {
        candidates.push({
          contactId: c.id,
          key: `decay-${c.id}`,
          href: `/contacts/${c.id}`,
          primary: `${name}'s half-life expired ${past}d ago`,
          secondary: `last contact ${dSince}d ago, half-life ${c.half_life_days.toFixed(0)}d`,
          urgency: 80 + past,
          tone: 'amber',
        })
      } else if (-past <= HALFLIFE_WARN_DAYS) {
        candidates.push({
          contactId: c.id,
          key: `decay-${c.id}`,
          href: `/contacts/${c.id}`,
          primary: `${name}'s half-life expires in ${-past}d`,
          secondary: `last contact ${dSince}d ago`,
          urgency: 70 - -past,
          tone: 'amber',
        })
      }
    }

    if (c.tier === 1 && dSince >= TIER1_SILENT_DAYS) {
      candidates.push({
        contactId: c.id,
        key: `silent-${c.id}`,
        href: `/contacts/${c.id}`,
        primary: `Follow up with ${name}`,
        secondary: `T1 — last contact ${dSince} days ago`,
        urgency: 60 + (dSince - TIER1_SILENT_DAYS),
        tone: 'indigo',
      })
    } else if (c.tier === 2 && dSince >= TIER2_SILENT_DAYS) {
      candidates.push({
        contactId: c.id,
        key: `silent-${c.id}`,
        href: `/contacts/${c.id}`,
        primary: `Follow up with ${name}`,
        secondary: `T2 — last contact ${dSince} days ago`,
        urgency: 40 + (dSince - TIER2_SILENT_DAYS),
        tone: 'indigo',
      })
    }
  }

  candidates.sort((a, b) => b.urgency - a.urgency)

  const seen = new Set<string>()
  const items: ActionItem[] = []
  for (const cand of candidates) {
    if (seen.has(cand.contactId)) continue
    seen.add(cand.contactId)
    items.push({
      key: cand.key,
      href: cand.href,
      primary: cand.primary,
      secondary: cand.secondary,
      urgency: cand.urgency,
      tone: cand.tone,
    })
    if (items.length >= ACTION_LIMIT) break
  }
  return items
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

async function loadActivity(
  supabase: SupabaseServerClient,
  userId: string,
  nameById: Map<string, string>,
): Promise<ActivityRow[]> {
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * DAY_MS).toISOString()
  const nowIso = new Date().toISOString()

  const [messagesRes, eventsRes, doneRes] = await Promise.all([
    supabase
      .from('messages')
      .select(
        'id, channel, direction, contact_id, subject, snippet, sender, recipient, sent_at',
      )
      .eq('user_id', userId)
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(15),
    supabase
      .from('calendar_events')
      .select('id, title, start_at, contact_id')
      .eq('user_id', userId)
      .lt('start_at', nowIso)
      .gte('start_at', since)
      .order('start_at', { ascending: false })
      .limit(10),
    supabase
      .from('commitments')
      .select('id, description, contact_id, completed_at')
      .eq('user_id', userId)
      .eq('status', 'done')
      .gte('completed_at', since)
      .order('completed_at', { ascending: false })
      .limit(10),
  ])

  const rows: ActivityRow[] = []

  type MessageRow = {
    id: string
    channel: 'email' | 'imessage' | 'sms'
    direction: 'inbound' | 'outbound'
    contact_id: string | null
    subject: string | null
    snippet: string | null
    sender: string | null
    recipient: string | null
    sent_at: string
  }
  for (const m of (messagesRes.data ?? []) as MessageRow[]) {
    const who =
      (m.contact_id && nameById.get(m.contact_id)) ||
      (m.direction === 'inbound' ? m.sender : m.recipient) ||
      'Unknown'
    const verb = m.direction === 'inbound' ? 'from' : 'to'
    const label =
      m.channel === 'email'
        ? 'Email'
        : m.channel === 'imessage'
          ? 'iMessage'
          : 'SMS'
    rows.push({
      key: `msg-${m.id}`,
      ts: m.sent_at,
      kind: m.channel,
      primary: `${label} ${verb} ${who}`,
      secondary: (m.subject || m.snippet || '').trim() || '—',
      href: m.contact_id ? `/contacts/${m.contact_id}` : undefined,
    })
  }

  type EventRow = {
    id: string
    title: string | null
    start_at: string
    contact_id: string | null
  }
  for (const e of (eventsRes.data ?? []) as EventRow[]) {
    rows.push({
      key: `evt-${e.id}`,
      ts: e.start_at,
      kind: 'meeting',
      primary: `Meeting — ${e.title || 'Untitled'}`,
      secondary: e.contact_id ? (nameById.get(e.contact_id) ?? '—') : '—',
      href: e.contact_id ? `/contacts/${e.contact_id}` : undefined,
    })
  }

  type DoneRow = {
    id: string
    description: string
    contact_id: string | null
    completed_at: string
  }
  for (const t of (doneRes.data ?? []) as DoneRow[]) {
    rows.push({
      key: `task-${t.id}`,
      ts: t.completed_at,
      kind: 'task',
      primary: `Completed: ${t.description}`,
      secondary: t.contact_id ? (nameById.get(t.contact_id) ?? '—') : '—',
      href: t.contact_id ? `/contacts/${t.contact_id}` : undefined,
    })
  }

  rows.sort((a, b) => b.ts.localeCompare(a.ts))
  return rows.slice(0, ACTIVITY_LIMIT)
}

function firstNameFromUser(user: {
  user_metadata?: {
    full_name?: string
    name?: string
    first_name?: string
  } | null
  email?: string | null
}): string | null {
  const md = user.user_metadata ?? {}
  if (md.first_name) return md.first_name
  const full = md.full_name ?? md.name
  if (full) return full.split(' ')[0]
  if (user.email) {
    const handle = user.email.split('@')[0]
    const part = handle.split(/[._-]/)[0]
    return part.charAt(0).toUpperCase() + part.slice(1)
  }
  return null
}

async function loadHomeData() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  const userId = user?.id ?? null

  const [contactsRes, commitmentsRes, googleRes, apolloRes] = await Promise.all([
    supabase.from('contacts').select('*').limit(2000),
    supabase
      .from('commitments')
      .select('id, contact_id, due_at, status, description')
      .limit(2000),
    user
      ? supabase
          .from('user_integrations')
          .select('provider')
          .eq('user_id', user.id)
          .in('provider', [
            'google_contacts',
            'google_calendar',
            'google_tasks',
            'google_gmail',
          ])
      : Promise.resolve({ data: [] }),
    user
      ? supabase
          .from('user_integrations')
          .select('access_token')
          .eq('user_id', user.id)
          .eq('provider', APOLLO_PROVIDER)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const contacts = (contactsRes.data ?? []) as Contact[]
  const commitments = (commitmentsRes.data ?? []) as CommitmentForList[]

  const googleProviders = new Set(
    (googleRes.data ?? []).map(
      (row: { provider: string }) => row.provider,
    ),
  )
  const googleConnected = googleProviders.size > 0

  const apolloConnected =
    typeof (apolloRes.data as { access_token?: unknown } | null)
      ?.access_token === 'string' &&
    ((apolloRes.data as { access_token: string }).access_token.length ?? 0) > 0

  const nameById = new Map(contacts.map((c) => [c.id, contactName(c)]))
  const service = getServiceClient()
  const [
    activity,
    briefingsResult,
    forgottenLoops,
    sentimentShifts,
    milestones,
    recentLifeEvents,
    owedToYou,
    reciprocityFlags,
    topicWatchHits,
  ] = await Promise.all([
    userId ? loadActivity(supabase, userId, nameById) : Promise.resolve([]),
    userId
      ? loadBriefings(supabase, userId, { windowHours: 48, limit: 1 })
      : Promise.resolve({
          briefings: [] as Briefing[],
          calendarConnected: false,
        }),
    userId && service
      ? findForgottenLoops(service, userId).catch((err) => {
          console.warn('[home] forgotten-loops failed', err)
          return [] as ForgottenLoop[]
        })
      : Promise.resolve([] as ForgottenLoop[]),
    userId && service
      ? findSentimentShifts(service, userId).catch((err) => {
          console.warn('[home] sentiment-shifts failed', err)
          return [] as SentimentShift[]
        })
      : Promise.resolve([] as SentimentShift[]),
    userId && service
      ? findUpcomingMilestones(service, userId).catch((err) => {
          console.warn('[home] milestone-radar failed', err)
          return [] as UpcomingMilestone[]
        })
      : Promise.resolve([] as UpcomingMilestone[]),
    userId && service
      ? findRecentLifeEvents(service, userId).catch((err) => {
          console.warn('[home] recent-life-events failed', err)
          return [] as RecentLifeEvent[]
        })
      : Promise.resolve([] as RecentLifeEvent[]),
    userId && service
      ? findOwedToYou(service, userId).catch((err) => {
          console.warn('[home] owed-to-you failed', err)
          return [] as OwedToYouItem[]
        })
      : Promise.resolve([] as OwedToYouItem[]),
    userId && service
      ? findReciprocityFlags(service, userId).catch((err) => {
          console.warn('[home] reciprocity-flags failed', err)
          return [] as ReciprocityFlag[]
        })
      : Promise.resolve([] as ReciprocityFlag[]),
    userId && service
      ? findTopicWatchHits(service, userId).catch((err) => {
          console.warn('[home] topic-watch failed', err)
          return [] as TopicWatchHit[]
        })
      : Promise.resolve([] as TopicWatchHit[]),
  ])
  const nextMeeting = briefingsResult.briefings[0] ?? null

  const total = contacts.length
  let active = 0
  let atRisk = 0
  let dormant = 0
  for (const c of contacts) {
    const dSince = daysSince(c.last_interaction_at)
    if (dSince == null) {
      dormant += 1
      continue
    }
    if (dSince <= ACTIVE_DAYS) active += 1
    if (
      typeof c.half_life_days === 'number' &&
      c.half_life_days > 0 &&
      dSince >= c.half_life_days - HALFLIFE_WARN_DAYS
    ) {
      atRisk += 1
    }
    if (dSince >= DORMANT_DAYS) dormant += 1
  }

  const actions = buildActionList(contacts, commitments)
  const firstName = user ? firstNameFromUser(user) : null

  return {
    firstName,
    googleConnected,
    apolloConnected,
    contactsTotal: total,
    health: { total, active, atRisk, dormant },
    actions,
    activity,
    nextMeeting,
    forgottenLoops,
    sentimentShifts,
    milestones,
    recentLifeEvents,
    owedToYou,
    reciprocityFlags,
    topicWatchHits,
  }
}

export default async function HomePage() {
  const {
    firstName,
    googleConnected,
    apolloConnected,
    contactsTotal,
    health,
    actions,
    activity,
    nextMeeting,
    forgottenLoops,
    sentimentShifts,
    milestones,
    recentLifeEvents,
    owedToYou,
    reciprocityFlags,
    topicWatchHits,
  } = await loadHomeData()

  const isFirstRun = contactsTotal === 0 && !googleConnected
  const showGetStarted = contactsTotal < GET_STARTED_THRESHOLD

  const eyebrow = (
    <>
      <Greeting />
      {firstName ? `, ${firstName}` : ''}
    </>
  )

  const subtitle =
    contactsTotal === 0
      ? isFirstRun
        ? "Three steps and you're set up. AIEA needs a few signals before it can start surfacing what your network needs."
        : 'No contacts yet. Import a CSV or connect Google to seed your network.'
      : actions.length === 0
        ? `Tracking ${contactsTotal} relationships. Network is in steady state — no urgent follow-ups today.`
        : `${actions.length} relationship${actions.length === 1 ? '' : 's'} need attention today.`

  return (
    <div className="space-y-10">
      <div className="animate-fade-up">
        <PageHeader
          eyebrow={eyebrow}
          title={isFirstRun ? 'Welcome to AIEA' : "Today's briefing"}
          subtitle={subtitle}
          action={
            !isFirstRun && contactsTotal > 0 ? (
              <Link
                href="/contacts/import"
                className="inline-flex items-center gap-1.5 rounded-xl aiea-cta px-4 py-2 text-sm font-medium text-white"
              >
                <span aria-hidden="true">＋</span> Import contacts
              </Link>
            ) : null
          }
        />
      </div>

      {isFirstRun && (
        <GettingStarted
          googleConnected={googleConnected}
          apolloConnected={apolloConnected}
          hasContacts={contactsTotal > 0}
        />
      )}

      {!isFirstRun && contactsTotal > 0 && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 aiea-stagger">
          <MetricCard
            label="Total contacts"
            value={health.total.toString()}
            tone="indigo"
            icon={<NetworkIcon />}
          />
          <MetricCard
            label="Active (30d)"
            value={health.active.toString()}
            hint={`${health.total ? Math.round((health.active / health.total) * 100) : 0}% of network · ${NETWORK_HEALTH_HELP}`}
            tone="violet"
            icon={<PulseIcon />}
          />
          <MetricCard
            label="At risk"
            value={health.atRisk.toString()}
            hint="half-life expiring"
            tone={health.atRisk > 0 ? 'amber' : 'emerald'}
            icon={<AlertIcon />}
          />
          <MetricCard
            label="Dormant (60d+)"
            value={health.dormant.toString()}
            hint="no recent contact"
            tone={health.dormant > 0 ? 'rose' : 'emerald'}
            icon={<MoonIcon />}
          />
        </div>
      )}

      {!isFirstRun && nextMeeting && (
        <div className="animate-fade-up">
          <NextMeetingCard meeting={nextMeeting} />
        </div>
      )}

      {!isFirstRun && contactsTotal > 0 && recentLifeEvents.length > 0 && (
        <RecentLifeEvents events={recentLifeEvents} />
      )}

      {!isFirstRun && contactsTotal > 0 && milestones.length > 0 && (
        <MilestoneRadar milestones={milestones} />
      )}

      {!isFirstRun && contactsTotal > 0 && topicWatchHits.length > 0 && (
        <TopicWatch hits={topicWatchHits} />
      )}

      {!isFirstRun && contactsTotal > 0 && forgottenLoops.length > 0 && (
        <ForgottenLoops loops={forgottenLoops} />
      )}

      {!isFirstRun && contactsTotal > 0 && owedToYou.length > 0 && (
        <OwedToYou items={owedToYou} />
      )}

      {!isFirstRun && contactsTotal > 0 && reciprocityFlags.length > 0 && (
        <ReciprocityFlags flags={reciprocityFlags} />
      )}

      {!isFirstRun && contactsTotal > 0 && sentimentShifts.length > 0 && (
        <SentimentShifts shifts={sentimentShifts} />
      )}

      {!isFirstRun && contactsTotal > 0 && (
        <section className="animate-fade-up">
          <SectionHeader
            eyebrow="Today"
            title={
              <span className="inline-flex items-center gap-2">
                Daily action list
                <HelpDot content="Ranked by urgency: overdue commitments first, then expiring half-lives, then silent T1/T2 contacts." />
              </span>
            }
            subtitle="Your top relationship moves, ranked by urgency."
          />
          {actions.length === 0 ? (
            <Card>
              <p className="text-sm text-zinc-400">
                Nothing pressing right now. Your network is in steady state.
              </p>
            </Card>
          ) : (
            <div className="grid gap-3 aiea-stagger">
              {actions.map((a, idx) => (
                <Link key={a.key} href={a.href} className="group block">
                  <Card interactive>
                    <div className="flex items-start gap-4">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] font-mono text-[11px] tabular-nums text-zinc-400">
                        {(idx + 1).toString().padStart(2, '0')}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="truncate text-sm font-medium text-zinc-100 group-hover:text-white">
                            {a.primary}
                          </span>
                          <ToneDot tone={a.tone} />
                        </div>
                        <div className="mt-0.5 truncate text-xs text-zinc-500">
                          {a.secondary}
                        </div>
                      </div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {!isFirstRun && contactsTotal > 0 && (
        <section className="animate-fade-up">
          <SectionHeader
            eyebrow="Pulse"
            title="Recent activity"
            subtitle="Emails, meetings, and tasks across your network."
          />
          {activity.length === 0 ? (
            <Card>
              <p className="text-sm text-zinc-500">
                No recent interactions in the last {ACTIVITY_WINDOW_DAYS} days.
              </p>
            </Card>
          ) : (
            <Card>
              <ul className="divide-y divide-white/[0.04]">
                {activity.map((row) => {
                  const inner = (
                    <div className="flex items-baseline justify-between gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <KindChip kind={row.kind} />
                          <span className="truncate text-sm text-zinc-100">
                            {row.primary}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-zinc-500">
                          {row.secondary}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                        {formatRelative(row.ts)}
                      </span>
                    </div>
                  )
                  return row.href ? (
                    <li key={row.key}>
                      <Link
                        href={row.href}
                        className="-mx-2 block rounded-md px-2 transition-colors hover:bg-white/[0.025]"
                      >
                        {inner}
                      </Link>
                    </li>
                  ) : (
                    <li key={row.key}>{inner}</li>
                  )
                })}
              </ul>
            </Card>
          )}
        </section>
      )}

      {!isFirstRun && contactsTotal > 0 && (
        <div className="animate-fade-up">
          <IntelligencePanel />
        </div>
      )}

      {!isFirstRun && showGetStarted && contactsTotal > 0 && (
        <section className="animate-fade-up">
          <EmptyState
            title="Add more contacts to unlock insights"
            body="Connect Google in Settings to seed contacts, or import a CSV. Once you have a few people in here, your daily briefing fills out automatically."
            action={
              <div className="flex items-center gap-2">
                <Link
                  href="/settings"
                  className="inline-flex items-center gap-1.5 rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white"
                >
                  Open settings →
                </Link>
                <Link
                  href="/contacts/import"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 hover:border-violet-500/40 hover:bg-white/[0.06]"
                >
                  Import CSV
                </Link>
              </div>
            }
          />
        </section>
      )}
    </div>
  )
}

function ToneDot({ tone }: { tone: ActionTone }) {
  const cls =
    tone === 'rose'
      ? 'bg-rose-400 shadow-rose-500/50'
      : tone === 'amber'
        ? 'bg-amber-400 shadow-amber-500/50'
        : tone === 'violet'
          ? 'bg-violet-400 shadow-violet-500/50'
          : 'bg-indigo-400 shadow-indigo-500/50'
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full shadow-[0_0_8px_currentColor] ${cls}`}
      aria-hidden="true"
    />
  )
}

function KindChip({ kind }: { kind: ActivityKind }) {
  const map: Record<ActivityKind, { label: string; cls: string }> = {
    email: {
      label: 'Email',
      cls: 'text-indigo-300 bg-indigo-500/10 ring-indigo-500/20',
    },
    imessage: {
      label: 'iMessage',
      cls: 'text-violet-300 bg-violet-500/10 ring-violet-500/20',
    },
    sms: {
      label: 'SMS',
      cls: 'text-violet-300 bg-violet-500/10 ring-violet-500/20',
    },
    meeting: {
      label: 'Meeting',
      cls: 'text-fuchsia-300 bg-fuchsia-500/10 ring-fuchsia-500/20',
    },
    task: {
      label: 'Done',
      cls: 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/20',
    },
  }
  const t = map[kind]
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ${t.cls}`}
    >
      {t.label}
    </span>
  )
}

function GettingStarted({
  googleConnected,
  apolloConnected,
  hasContacts,
}: {
  googleConnected: boolean
  apolloConnected: boolean
  hasContacts: boolean
}) {
  const steps: Array<{
    n: number
    title: string
    body: string
    href: string
    cta: string
    done: boolean
    highlight: boolean
  }> = [
    {
      n: 1,
      title: 'Connect Google',
      body:
        'AIEA reads your Calendar, Gmail, and Contacts to build your relationship graph. One consent screen — nothing leaves your account.',
      href: '/settings',
      cta: googleConnected ? 'Manage' : 'Connect Google',
      done: googleConnected,
      highlight: !googleConnected,
    },
    {
      n: 2,
      title: 'Import contacts',
      body:
        "Upload a CSV or let Google sync pull them in. AIEA needs people before it can tell you who needs attention.",
      href: '/contacts/import',
      cta: hasContacts ? 'Manage' : 'Import contacts',
      done: hasContacts,
      highlight: googleConnected && !hasContacts,
    },
    {
      n: 3,
      title: 'Enable enrichment (optional)',
      body:
        'Add an Apollo.io API key to auto-fill titles, companies, and LinkedIn for any contact.',
      href: '/settings',
      cta: apolloConnected ? 'Manage' : 'Add API key',
      done: apolloConnected,
      highlight: false,
    },
  ]
  return (
    <section className="animate-fade-up">
      <Card className="space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-medium text-zinc-100">Get started</h2>
          <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
            {steps.filter((s) => s.done).length} of {steps.length} done
          </span>
        </div>
        <ol className="space-y-3">
          {steps.map((s) => (
            <li
              key={s.n}
              className={`flex items-start gap-4 rounded-xl border px-4 py-4 transition-colors ${
                s.done
                  ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
                  : s.highlight
                    ? 'border-violet-500/40 bg-violet-500/[0.06]'
                    : 'border-white/[0.06] bg-white/[0.02]'
              }`}
            >
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ring-1 ring-inset ${
                  s.done
                    ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                    : s.highlight
                      ? 'bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white ring-violet-400/40 shadow-lg shadow-violet-500/30'
                      : 'bg-white/[0.04] text-zinc-300 ring-white/10'
                }`}
              >
                {s.done ? '✓' : s.n}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-zinc-100">
                  {s.title}
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
                  {s.body}
                </p>
              </div>
              <Link
                href={s.href}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  s.done
                    ? 'border border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/20'
                    : s.highlight
                      ? 'aiea-cta text-white'
                      : 'border border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/20'
                }`}
              >
                {s.cta}
              </Link>
            </li>
          ))}
        </ol>
        <p className="pt-2 text-[11px] text-zinc-500">
          AIEA gets smarter as you use it. Within 24-48 hours of connecting,
          you&apos;ll see your first daily briefing.
        </p>
      </Card>
    </section>
  )
}

function NextMeetingCard({ meeting }: { meeting: Briefing }) {
  const matched = meeting.attendees.filter(
    (a): a is MatchedAttendee => a.kind === 'matched',
  )
  const unmatchedCount = meeting.attendees.length - matched.length

  return (
    <Link
      href={`/briefings/${meeting.event_id}`}
      className="group block rounded-2xl aiea-glass aiea-lift p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
            Next meeting
          </div>
          <div className="mt-1 truncate text-base font-medium text-zinc-100 group-hover:text-violet-200">
            {meeting.title || 'Untitled meeting'}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {formatNextMeetingTime(meeting.start_at)}
            {meeting.location ? ` · ${meeting.location}` : ''}
          </div>
        </div>
        <span className="text-xs text-violet-300 transition-colors group-hover:text-violet-200">
          Full briefing →
        </span>
      </div>

      {matched.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {matched.slice(0, 4).map((a) => (
            <li
              key={a.contact_id}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.03] px-2.5 py-1 text-xs ring-1 ring-inset ring-white/[0.06]"
            >
              <span className="text-zinc-100">{a.name}</span>
              {a.tier != null && (
                <span className="text-[10px] text-zinc-500">
                  · T{a.tier}
                </span>
              )}
              {a.health !== 'unknown' && (
                <span
                  className={`text-[10px] ${
                    a.health === 'cold' || a.health === 'cooling'
                      ? 'text-amber-300'
                      : 'text-emerald-300'
                  }`}
                >
                  · {a.health}
                </span>
              )}
            </li>
          ))}
          {matched.length > 4 && (
            <li className="inline-flex items-center rounded-full bg-white/[0.02] px-2.5 py-1 text-xs text-zinc-500 ring-1 ring-inset ring-white/[0.04]">
              +{matched.length - 4} more
            </li>
          )}
          {unmatchedCount > 0 && (
            <li className="inline-flex items-center rounded-full border border-dashed border-white/[0.12] px-2.5 py-1 text-xs text-zinc-500">
              {unmatchedCount} unknown
            </li>
          )}
        </ul>
      )}

      {meeting.talking_points.length > 0 && (
        <div className="mt-4 rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-3">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-violet-300">
            Top reminder
          </div>
          <p className="text-sm leading-snug text-zinc-200">
            <span className="mr-1.5 text-violet-400">→</span>
            {meeting.talking_points[0]}
          </p>
        </div>
      )}
    </Link>
  )
}

function formatNextMeetingTime(iso: string): string {
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

function NetworkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5" cy="6" r="1.8" />
      <circle cx="19" cy="6" r="1.8" />
      <circle cx="5" cy="18" r="1.8" />
      <circle cx="19" cy="18" r="1.8" />
      <path d="M12 12L5 6m7 6l7-6m-7 6l-7 6m7-6l7 6" />
    </svg>
  )
}

function PulseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}
