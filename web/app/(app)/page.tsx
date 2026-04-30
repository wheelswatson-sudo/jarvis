import Link from 'next/link'
import { createClient } from '../../lib/supabase/server'
import { Card, MetricCard, SectionHeader } from '../../components/cards'
import { HalfLifeGauge, SentimentSlope } from '../../components/Gauge'
import {
  formatCurrency,
  formatPercent,
  formatRelative,
  tierColor,
  tierLabel,
} from '../../lib/format'
import type { Commitment, Contact } from '../../lib/types'

export const dynamic = 'force-dynamic'

type ContactWithStats = Contact & { open_commitments: number }

async function loadDashboard() {
  const supabase = await createClient()
  const now = new Date().toISOString()

  const [contactsRes, commitmentsRes] = await Promise.all([
    supabase
      .from('contacts')
      .select('*')
      .order('ltv_estimate', { ascending: false, nullsFirst: false })
      .limit(120),
    supabase
      .from('commitments')
      .select('id, contact_id, due_at, status, description'),
  ])

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

  // Health = average half-life / 90, clamped 0..1.
  const halfLifes = enriched
    .map((c) => c.half_life_days)
    .filter((v): v is number => typeof v === 'number')
  const networkHealth = halfLifes.length
    ? Math.max(0, Math.min(1, halfLifes.reduce((s, v) => s + v, 0) / halfLifes.length / 90))
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

  return {
    enriched,
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
  const { metrics, needsAttention, topByLtv, enriched } = data
  const maxLtv = topByLtv[0]?.ltv_estimate ?? 1

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {metrics.activeRelationships} relationships in your network.
        </p>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard
          label="Active relationships"
          value={metrics.activeRelationships.toString()}
        />
        <MetricCard
          label="Network health"
          value={formatPercent(metrics.networkHealth)}
          hint="avg half-life vs 90d"
        />
        <MetricCard
          label="Commitments due"
          value={metrics.openCount.toString()}
          hint={`${metrics.overdueCount} overdue`}
        />
        <MetricCard
          label="Predicted network LTV"
          value={formatCurrency(metrics.totalLtv)}
        />
      </div>

      {/* Needs attention */}
      <section>
        <SectionHeader
          title="Needs attention"
          subtitle="Where to spend your time first."
        />
        <div className="grid gap-4 md:grid-cols-3">
          <AttentionList
            tone="red"
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
              primary: c.name,
              secondary: `half-life ${c.half_life_days?.toFixed(0)}d`,
            }))}
          />
          <AttentionList
            tone="blue"
            title="Reactivation opportunities"
            empty="No T1 contacts gone cold."
            items={needsAttention.reactivation.slice(0, 5).map((c) => ({
              key: c.id,
              href: `/contacts/${c.id}`,
              primary: c.name,
              secondary: `last seen ${formatRelative(c.last_interaction_at)}`,
            }))}
          />
        </div>
      </section>

      {/* LTV ranking */}
      <section>
        <SectionHeader
          title="Relationship LTV ranking"
          subtitle="Top contacts by predicted lifetime value."
        />
        <Card>
          {topByLtv.length === 0 ? (
            <p className="text-sm text-zinc-500">No LTV estimates yet.</p>
          ) : (
            <ul className="space-y-3">
              {topByLtv.map((c) => {
                const pct = Math.max(0, Math.min(1, (c.ltv_estimate ?? 0) / maxLtv))
                return (
                  <li key={c.id}>
                    <Link
                      href={`/contacts/${c.id}`}
                      className="group block"
                    >
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="font-medium group-hover:underline">
                          {c.name}
                        </span>
                        <span className="tabular-nums text-zinc-500">
                          {formatCurrency(c.ltv_estimate)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
                        <div
                          className="h-full bg-zinc-900"
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

      {/* Contact grid */}
      <section>
        <SectionHeader
          title="Contacts"
          subtitle="Click a card to drill in."
        />
        {enriched.length === 0 ? (
          <Card>
            <p className="text-sm text-zinc-500">
              No contacts yet. The sync scripts will populate this.
            </p>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {enriched.slice(0, 30).map((c) => (
              <Link
                key={c.id}
                href={`/contacts/${c.id}`}
                className="group rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-zinc-300"
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate text-xs text-zinc-500">
                      {[c.title, c.company].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tierColor(c.tier)}`}
                  >
                    {tierLabel(c.tier)}
                  </span>
                </div>
                <div className="mt-4">
                  <div className="mb-1 flex items-center justify-between text-xs text-zinc-500">
                    <span>Half-life</span>
                    <span className="tabular-nums">
                      {c.half_life_days != null
                        ? `${c.half_life_days.toFixed(0)}d`
                        : '—'}
                    </span>
                  </div>
                  <HalfLifeGauge days={c.half_life_days} />
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
                  <SentimentSlope slope={c.sentiment_slope} />
                  <span>
                    {c.open_commitments > 0
                      ? `${c.open_commitments} open`
                      : 'no commitments'}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
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
  tone: 'red' | 'amber' | 'blue'
  items: AttentionItem[]
  empty: string
}) {
  const dot =
    tone === 'red' ? 'bg-red-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-blue-500'
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-400">{empty}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const inner = (
              <>
                <div className="truncate text-sm font-medium">{item.primary}</div>
                <div className="text-xs text-zinc-500">{item.secondary}</div>
              </>
            )
            return (
              <li key={item.key}>
                {item.href ? (
                  <Link href={item.href} className="block hover:underline">
                    {inner}
                  </Link>
                ) : (
                  <div>{inner}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
