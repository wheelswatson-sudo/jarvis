import Link from 'next/link'
import { createClient } from '../../lib/supabase/server'
import {
  Card,
  EmptyState,
  MetricCard,
  PageHeader,
  SectionHeader,
} from '../../components/cards'
import { HelpDot } from '../../components/Tooltip'
import { Greeting } from '../../components/Greeting'
import { IntelligencePanel } from '../../components/IntelligencePanel'
import { ContactsGrid } from '../../components/ContactsGrid'
import {
  contactName,
  formatCurrency,
  formatPercent,
  formatRelative,
} from '../../lib/format'
import {
  LTV_HELP,
  NETWORK_HEALTH_HELP,
  COMMITMENT_HELP,
} from '../../lib/glossary'
import type { Commitment, Contact } from '../../lib/types'
import { APOLLO_PROVIDER } from '../../lib/apollo'

export const dynamic = 'force-dynamic'

type ContactWithStats = Contact & { open_commitments: number }

async function loadDashboard() {
  const supabase = await createClient()
  const now = new Date().toISOString()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [contactsRes, commitmentsRes, apolloRes, googleRes] = await Promise.all([
    supabase
      .from('contacts')
      .select('*')
      .order('ltv_estimate', { ascending: false, nullsFirst: false })
      .limit(120),
    supabase
      .from('commitments')
      .select('id, contact_id, due_at, status, description'),
    user
      ? supabase
          .from('user_integrations')
          .select('access_token')
          .eq('user_id', user.id)
          .eq('provider', APOLLO_PROVIDER)
          .maybeSingle()
      : Promise.resolve({ data: null }),
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
  ])

  const apolloConnected =
    typeof (apolloRes.data as { access_token?: unknown } | null)
      ?.access_token === 'string' &&
    ((apolloRes.data as { access_token: string }).access_token.length ?? 0) > 0

  const contacts = (contactsRes.data ?? []) as Contact[]
  const commitments = (commitmentsRes.data ?? []) as Pick<
    Commitment,
    'id' | 'contact_id' | 'due_at' | 'status' | 'description'
  >[]

  const openByContact = new Map<string, number>()
  let openCount = 0
  let overdueCount = 0
  for (const c of commitments) {
    if (c.status !== 'open') continue
    openCount++
    if (c.due_at && c.due_at < now) overdueCount++
    if (c.contact_id) {
      openByContact.set(c.contact_id, (openByContact.get(c.contact_id) ?? 0) + 1)
    }
  }

  const enriched: ContactWithStats[] = contacts.map((c) => ({
    ...c,
    open_commitments: openByContact.get(c.id) ?? 0,
  }))

  const totalLtv = enriched.reduce((sum, c) => sum + (c.ltv_estimate ?? 0), 0)

  const halfLifes = enriched
    .map((c) => c.half_life_days)
    .filter((v): v is number => typeof v === 'number')
  const networkHealth = halfLifes.length
    ? Math.max(
        0,
        Math.min(1, halfLifes.reduce((s, v) => s + v, 0) / halfLifes.length / 90),
      )
    : null

  const cooling = enriched.filter(
    (c) => c.half_life_days != null && c.half_life_days < 21,
  )
  const reactivation = enriched.filter(
    (c) =>
      c.tier === 1 &&
      c.last_interaction_at &&
      Date.now() - new Date(c.last_interaction_at).getTime() >
        60 * 24 * 60 * 60 * 1000,
  )

  const overdue = commitments
    .filter((c) => c.status === 'open' && c.due_at && c.due_at < now)
    .slice(0, 5)

  const topByLtv = [...enriched]
    .filter((c) => (c.ltv_estimate ?? 0) > 0)
    .slice(0, 8)

  const googleProviders = new Set(
    (googleRes.data ?? []).map(
      (row: { provider: string }) => row.provider,
    ),
  )

  return {
    enriched,
    apolloConnected,
    googleConnected: googleProviders.size > 0,
    metrics: {
      activeRelationships: enriched.length,
      networkHealth,
      openCount,
      overdueCount,
      totalLtv,
    },
    needsAttention: { overdue, cooling, reactivation },
    topByLtv,
  }
}

export default async function DashboardPage() {
  const data = await loadDashboard()
  const {
    metrics,
    needsAttention,
    topByLtv,
    enriched,
    apolloConnected,
    googleConnected,
  } = data
  const maxLtv = topByLtv[0]?.ltv_estimate ?? 1
  const isFirstRun = enriched.length === 0 && !googleConnected

  return (
    <div className="space-y-10">
      {/* Hero */}
      <div className="animate-fade-up">
        <PageHeader
          eyebrow={<Greeting />}
          title={isFirstRun ? 'Welcome to AIEA' : "Here's what your network needs"}
          subtitle={
            metrics.activeRelationships > 0
              ? `Tracking ${metrics.activeRelationships} relationships. ${metrics.openCount} open commitment${metrics.openCount === 1 ? '' : 's'}${metrics.overdueCount ? ` — ${metrics.overdueCount} overdue.` : '.'}`
              : isFirstRun
                ? "Three steps and you're set up. AIEA needs a few signals before it can start surfacing what your network needs."
                : 'No contacts yet. Import a CSV or connect Google to seed your network.'
          }
          action={
            !isFirstRun && (
              <Link
                href="/contacts/import"
                className="inline-flex items-center gap-1.5 rounded-xl aiea-cta px-4 py-2 text-sm font-medium text-white"
              >
                <span aria-hidden="true">＋</span> Import contacts
              </Link>
            )
          }
        />
      </div>

      {isFirstRun && (
        <GettingStarted
          googleConnected={googleConnected}
          apolloConnected={apolloConnected}
          hasContacts={enriched.length > 0}
        />
      )}

      {/* Metrics row */}
      {!isFirstRun && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 aiea-stagger">
          <MetricCard
            label="Active relationships"
            value={metrics.activeRelationships.toString()}
            tone="indigo"
            icon={<NetworkIcon />}
          />
          <MetricCard
            label="Network health"
            value={formatPercent(metrics.networkHealth)}
            hint={NETWORK_HEALTH_HELP}
            tone="violet"
            icon={<PulseIcon />}
          />
          <MetricCard
            label="Commitments due"
            value={metrics.openCount.toString()}
            hint={
              metrics.overdueCount > 0
                ? `${metrics.overdueCount} overdue · ${COMMITMENT_HELP}`
                : COMMITMENT_HELP
            }
            tone={metrics.overdueCount > 0 ? 'rose' : 'emerald'}
            icon={<CheckIcon />}
          />
          <MetricCard
            label="Predicted network LTV"
            value={formatCurrency(metrics.totalLtv)}
            hint={LTV_HELP}
            tone="fuchsia"
            icon={<SparklesIcon />}
          />
        </div>
      )}

      {/* Intelligence — self-improving insights */}
      {!isFirstRun && (
        <div className="animate-fade-up">
          <IntelligencePanel />
        </div>
      )}

      {/* Needs attention */}
      {!isFirstRun && (
      <section className="animate-fade-up">
        <SectionHeader
          eyebrow="Triage"
          title="Needs attention"
          subtitle="Where to spend your time first."
        />
        <div className="grid gap-4 md:grid-cols-3 aiea-stagger">
          <AttentionList
            tone="rose"
            title="Overdue commitments"
            empty="Nothing overdue."
            items={needsAttention.overdue.map((c) => ({
              key: c.id,
              primary: c.description,
              secondary: `due ${formatRelative(c.due_at)}`,
            }))}
          />
          <AttentionList
            tone="amber"
            title="Cooling relationships"
            empty="Network is warm."
            items={needsAttention.cooling.slice(0, 5).map((c) => ({
              key: c.id,
              href: `/contacts/${c.id}`,
              primary: contactName(c),
              secondary: `half-life ${c.half_life_days?.toFixed(0)}d`,
            }))}
          />
          <AttentionList
            tone="indigo"
            title="Reactivation opportunities"
            empty="No Tier 1 contacts have gone cold."
            items={needsAttention.reactivation.slice(0, 5).map((c) => ({
              key: c.id,
              href: `/contacts/${c.id}`,
              primary: contactName(c),
              secondary: `last seen ${formatRelative(c.last_interaction_at)}`,
            }))}
          />
        </div>
      </section>
      )}

      {/* LTV ranking */}
      {!isFirstRun && (
      <section className="animate-fade-up">
        <SectionHeader
          eyebrow="Compounding"
          title={
            <span className="inline-flex items-center gap-2">
              Relationship LTV ranking
              <HelpDot content={LTV_HELP} />
            </span>
          }
          subtitle="Top contacts by predicted lifetime value."
        />
        <Card>
          {topByLtv.length === 0 ? (
            <div className="py-8 text-center">
              <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 ring-1 ring-inset ring-white/10 text-violet-200">
                <SparklesIcon />
              </div>
              <p className="text-sm font-medium text-zinc-200">
                No LTV estimates yet
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-500">
                LTV scores appear once contacts have enough interaction
                history. Log a few meetings to start the model.
              </p>
            </div>
          ) : (
            <ul className="space-y-4 aiea-stagger">
              {topByLtv.map((c, idx) => {
                const pct = Math.max(
                  0,
                  Math.min(1, (c.ltv_estimate ?? 0) / maxLtv),
                )
                return (
                  <li key={c.id}>
                    <Link
                      href={`/contacts/${c.id}`}
                      className="group block rounded-lg p-2 -m-2 transition-colors hover:bg-white/[0.025]"
                    >
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="flex items-baseline gap-3 truncate">
                          <span className="w-5 shrink-0 font-mono text-[11px] tabular-nums text-zinc-600">
                            {(idx + 1).toString().padStart(2, '0')}
                          </span>
                          <span className="truncate font-medium text-zinc-100 transition-colors group-hover:text-white">
                            {contactName(c)}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums text-zinc-400 transition-colors group-hover:text-zinc-200">
                          {formatCurrency(c.ltv_estimate)}
                        </span>
                      </div>
                      <div className="mt-2 ml-8 h-1.5 w-[calc(100%-2rem)] overflow-hidden rounded-full bg-white/[0.04]">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 shadow-[0_0_8px_rgba(139,92,246,0.45)] transition-[width] duration-700"
                          style={{ width: `${pct * 100}%` }}
                        />
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </section>
      )}

      {/* Contact grid */}
      {!isFirstRun && (
      <section className="animate-fade-up">
        <SectionHeader
          eyebrow="People"
          title="Your network"
          subtitle="Click a card to drill in."
          action={
            <Link
              href="/contacts/import"
              className="inline-flex items-center gap-1.5 rounded-lg aiea-cta px-3.5 py-1.5 text-sm font-medium text-white"
            >
              <span aria-hidden="true">＋</span> Import
            </Link>
          }
        />
        {enriched.length === 0 ? (
          <EmptyState
            icon={<NetworkIcon />}
            title="No contacts yet"
            body="Import a CSV to seed your network, or connect Google in Settings to sync automatically."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Link
                  href="/contacts/import"
                  className="inline-flex items-center gap-1.5 rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white"
                >
                  Import your first contacts →
                </Link>
                <Link
                  href="/settings"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
                >
                  Open settings
                </Link>
              </div>
            }
          />
        ) : (
          <ContactsGrid
            contacts={enriched}
            apolloConnected={apolloConnected}
          />
        )}
      </section>
      )}
    </div>
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

type AttentionItem = {
  key: string
  href?: string
  primary: string
  secondary: string
}

function AttentionList({
  title,
  tone,
  items,
  empty,
}: {
  title: string
  tone: 'rose' | 'amber' | 'indigo'
  items: AttentionItem[]
  empty: string
}) {
  const dot =
    tone === 'rose'
      ? 'bg-rose-400 shadow-rose-500/50'
      : tone === 'amber'
        ? 'bg-amber-400 shadow-amber-500/50'
        : 'bg-indigo-400 shadow-indigo-500/50'
  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full shadow-[0_0_8px_currentColor] ${dot}`}
          aria-hidden="true"
        />
        <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
        <span className="ml-auto text-[10px] tabular-nums text-zinc-600">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">{empty}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const inner = (
              <>
                <div className="truncate text-sm font-medium text-zinc-100">
                  {item.primary}
                </div>
                <div className="text-xs text-zinc-500">{item.secondary}</div>
              </>
            )
            return (
              <li key={item.key}>
                {item.href ? (
                  <Link
                    href={item.href}
                    className="-mx-2 block rounded-md px-2 py-1.5 transition-colors hover:bg-white/[0.025]"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className="px-0">{inner}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
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
function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 12 5 5L20 6" />
    </svg>
  )
}
function SparklesIcon() {
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
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
      <path d="M19 16l.6 1.6L21 18l-1.4.4L19 20l-.6-1.6L17 18l1.4-.4z" />
    </svg>
  )
}
