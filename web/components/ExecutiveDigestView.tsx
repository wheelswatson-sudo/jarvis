import Link from 'next/link'
import { Card, PageHeader, SectionHeader } from './cards'
import type { ExecutiveDigestPayload } from '../lib/intelligence/executive-digest'

export type DigestViewModel = {
  payload: ExecutiveDigestPayload
  markdown: string
}

export function ExecutiveDigestView({ digest }: { digest: DigestViewModel }) {
  const p = digest.payload
  const m = p.metrics
  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Friday memo"
        title={`Week of ${formatDate(p.week_starting)}`}
        subtitle={`Generated ${formatRelative(p.generated_at)}${p.model ? ` · ${p.model}` : ''}`}
      />

      <section className="animate-fade-up">
        <Card className="space-y-3">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-violet-300">
            The bottom line
          </div>
          <p className="text-base leading-relaxed text-zinc-100 whitespace-pre-line">
            {p.narrative}
          </p>
        </Card>
      </section>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4 aiea-stagger">
        <Metric
          label="Interactions"
          value={m.total_interactions.toString()}
          hint={`${m.inbound} in · ${m.outbound} out`}
        />
        <Metric label="Contacts touched" value={m.unique_contacts.toString()} />
        <Metric label="Meetings held" value={m.meetings_held.toString()} />
        <Metric
          label="Commitments"
          value={`${m.commitments_completed} done`}
          hint={`${m.commitments_created} new · ${m.commitments_overdue} overdue`}
          tone={m.commitments_overdue > 0 ? 'amber' : 'emerald'}
        />
      </section>

      {(p.warming.length > 0 || p.cooling.length > 0) && (
        <section className="animate-fade-up">
          <SectionHeader
            eyebrow="Movement"
            title="Relationships on the move"
            subtitle="Sentiment or composite scores that shifted meaningfully this week."
          />
          <div className="grid gap-3 md:grid-cols-2 aiea-stagger">
            {p.warming.map((w) => (
              <MoveCard
                key={`w-${w.contact_id}`}
                direction="warmed"
                name={w.contact_name}
                prior={w.prior_pct}
                current={w.current_pct}
                delta={w.delta_pct}
                href={`/contacts/${w.contact_id}`}
              />
            ))}
            {p.cooling.map((c) => (
              <MoveCard
                key={`c-${c.contact_id}`}
                direction="cooled"
                name={c.contact_name}
                prior={c.prior_pct}
                current={c.current_pct}
                delta={c.delta_pct}
                href={`/contacts/${c.contact_id}`}
              />
            ))}
          </div>
        </section>
      )}

      {p.open_loops.length > 0 && (
        <section className="animate-fade-up">
          <SectionHeader
            eyebrow="Carry forward"
            title="Open loops"
            subtitle="What's still waiting on you next week."
          />
          <Card>
            <ul className="divide-y divide-white/[0.04]">
              {p.open_loops.map((l, i) => (
                <li key={i} className="py-3">
                  <Link
                    href={`/contacts/${l.contact_id}`}
                    className="block transition-colors hover:text-violet-200"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-zinc-100">{l.hint}</span>
                      <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                        {l.days}d
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {p.due_next_week.length > 0 && (
        <section className="animate-fade-up">
          <SectionHeader
            eyebrow="Up next"
            title="Coming due"
            subtitle="Commitments with due dates in the next 7 days."
          />
          <Card>
            <ul className="divide-y divide-white/[0.04]">
              {p.due_next_week.map((d, i) => (
                <li key={i} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="text-sm text-zinc-100">
                        {d.description}
                      </span>
                      {d.contact_name && (
                        <span className="ml-2 text-xs text-zinc-500">
                          — {d.contact_name}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                      {d.due_at ? formatDate(d.due_at) : '—'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {p.milestones && p.milestones.length > 0 && (
        <section className="animate-fade-up">
          <SectionHeader
            eyebrow="Radar"
            title="Milestones coming up"
            subtitle="Birthdays and key milestones in the next two weeks."
          />
          <Card>
            <ul className="divide-y divide-white/[0.04]">
              {p.milestones.map((m, i) => (
                <li key={i} className="py-3">
                  <Link
                    href={`/contacts/${m.contact_id}`}
                    className="block transition-colors hover:text-violet-200"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <span className="text-sm text-zinc-100">
                          {m.contact_name}
                        </span>
                        <span className="ml-2 text-xs text-zinc-500">
                          — {m.kind === 'birthday' ? 'birthday' : m.label}
                        </span>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                        {m.days_until === 0
                          ? 'today'
                          : m.days_until === 1
                            ? 'tomorrow'
                            : `${m.days_until}d`}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section className="animate-fade-up">
        <SectionHeader
          eyebrow="Copy out"
          title="Markdown"
          subtitle="Paste-able for email or Slack."
        />
        <Card>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-300">
            {digest.markdown}
          </pre>
        </Card>
      </section>
    </div>
  )
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'amber' | 'emerald'
}) {
  const toneCls =
    tone === 'amber'
      ? 'text-amber-300'
      : tone === 'emerald'
        ? 'text-emerald-300'
        : 'text-zinc-100'
  return (
    <Card className="space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
        {label}
      </div>
      <div className={`text-2xl font-medium tabular-nums ${toneCls}`}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-zinc-500">{hint}</div>}
    </Card>
  )
}

function MoveCard({
  direction,
  name,
  prior,
  current,
  delta,
  href,
}: {
  direction: 'warmed' | 'cooled'
  name: string
  prior: number
  current: number
  delta: number
  href: string
}) {
  const isWarm = direction === 'warmed'
  const arrow = isWarm ? '↑' : '↓'
  const accent = isWarm ? 'text-emerald-300' : 'text-amber-300'
  const chip = isWarm
    ? 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/30'
    : 'bg-amber-500/10 text-amber-200 ring-amber-500/30'
  return (
    <Link href={href} className="group block">
      <Card interactive className="space-y-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${chip}`}
          >
            <span aria-hidden="true" className={accent}>
              {arrow}
            </span>
            {isWarm ? 'Warming' : 'Cooling'}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium text-zinc-100 group-hover:text-white">
            {name}
          </span>
          <span className={`shrink-0 text-xs tabular-nums ${accent}`}>
            {arrow} {delta}%
          </span>
        </div>
        <div className="text-[11px] tabular-nums text-zinc-500">
          {prior}% → {current}%
        </div>
      </Card>
    </Link>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatRelative(iso: string): string {
  const d = new Date(iso).getTime()
  if (!Number.isFinite(d)) return iso
  const hours = Math.floor((Date.now() - d) / (60 * 60 * 1000))
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}
