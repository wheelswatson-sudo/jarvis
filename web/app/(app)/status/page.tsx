'use client'

import { useEffect, useState } from 'react'

type ComponentStatus = 'operational' | 'degraded' | 'down'

type HealthComponent = {
  name: string
  status: ComponentStatus
  latency_ms: number
  last_checked: string
  details?: string
}

type HealthResponse = {
  status: ComponentStatus
  components: HealthComponent[]
  timestamp: string
  commit: string | null
  env: string | null
}

type IntelligenceHealth = {
  capsules: {
    total: number
    by_status: Record<string, number>
    by_type: Record<string, number>
  }
  insights: {
    total: number
    by_status: Record<string, number>
    acceptance_rate_30d: number | null
  }
  events_30d: number
  last_analysis: { at: string; details: Record<string, unknown> } | null
  recent_log: {
    event_type: string
    details: Record<string, unknown>
    created_at: string
  }[]
}

const REFRESH_MS = 30_000
const SENTRY_URL = process.env.NEXT_PUBLIC_SENTRY_DASHBOARD_URL ?? null

export default function StatusPage() {
  const [data, setData] = useState<HealthResponse | null>(null)
  const [intel, setIntel] = useState<IntelligenceHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)

  async function fetchHealth() {
    try {
      const [sysRes, intelRes] = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }),
        fetch('/api/intelligence/health', { cache: 'no-store' }),
      ])
      const json = (await sysRes.json()) as HealthResponse
      setData(json)
      if (intelRes.ok) {
        setIntel((await intelRes.json()) as IntelligenceHealth)
      }
      setError(null)
      setLastFetched(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch health')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchHealth()
    const id = setInterval(fetchHealth, REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="-mx-4 -my-8 min-h-[calc(100vh-3.5rem)] bg-zinc-950 px-4 py-10 sm:-mx-6 sm:px-6">
      <div className="mx-auto max-w-4xl space-y-8">
        <header>
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-medium text-violet-300">
            <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400" />
            System Status
          </div>
          <h1 className="mt-3 bg-gradient-to-r from-indigo-200 via-violet-200 to-fuchsia-200 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
            Status
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Real-time health of every component the product depends on. Refreshes
            every 30 seconds.
          </p>
        </header>

        <OverallBanner data={data} loading={loading} error={error} />

        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-zinc-300">Components</h2>
            <span className="text-xs text-zinc-500">
              {lastFetched
                ? `Checked ${formatTime(lastFetched)}`
                : loading
                  ? 'Checking…'
                  : '—'}
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border border-white/5 bg-zinc-900/40">
            {loading && !data ? (
              <SkeletonRows />
            ) : data ? (
              <ul className="divide-y divide-white/5">
                {data.components.map((c) => (
                  <ComponentRow key={c.name} component={c} />
                ))}
              </ul>
            ) : (
              <div className="p-6 text-sm text-zinc-500">
                Unable to load component data.
              </div>
            )}
          </div>
        </section>

        <IntelligenceStatusPanel intel={intel} />

        <section className="rounded-xl border border-white/5 bg-zinc-900/40 p-5">
          <h2 className="text-sm font-medium text-zinc-300">Recent incidents</h2>
          <p className="mt-2 text-sm text-zinc-500">
            {SENTRY_URL ? (
              <>
                Errors and exceptions are tracked in Sentry.{' '}
                <a
                  href={SENTRY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-violet-300 underline-offset-2 hover:underline"
                >
                  Open Sentry dashboard
                </a>
                .
              </>
            ) : (
              'Sentry is not configured. Set NEXT_PUBLIC_SENTRY_DASHBOARD_URL to link incidents here.'
            )}
          </p>
        </section>

        {data && (
          <footer className="flex items-center justify-between text-xs text-zinc-600">
            <span>
              Build{' '}
              <span className="font-mono text-zinc-400">
                {data.commit ? data.commit.slice(0, 7) : 'local'}
              </span>
              {data.env ? ` · ${data.env}` : ''}
            </span>
            <a
              href="/api/health"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono hover:text-zinc-400"
            >
              /api/health →
            </a>
          </footer>
        )}
      </div>
    </div>
  )
}

function OverallBanner({
  data,
  loading,
  error,
}: {
  data: HealthResponse | null
  loading: boolean
  error: string | null
}) {
  if (error) {
    return (
      <Banner
        tone="down"
        title="Unable to reach status endpoint"
        subtitle={error}
      />
    )
  }
  if (loading && !data) {
    return <Banner tone="loading" title="Checking systems…" subtitle="" />
  }
  if (!data) return null

  const map: Record<
    ComponentStatus,
    { title: string; subtitle: string; tone: BannerTone }
  > = {
    operational: {
      title: 'All systems operational',
      subtitle: 'Every component is responding normally.',
      tone: 'operational',
    },
    degraded: {
      title: 'Partial degradation',
      subtitle: 'Some components are slow or returning warnings.',
      tone: 'degraded',
    },
    down: {
      title: 'Service disruption',
      subtitle: 'One or more components are unreachable.',
      tone: 'down',
    },
  }
  const cfg = map[data.status]
  return <Banner tone={cfg.tone} title={cfg.title} subtitle={cfg.subtitle} />
}

type BannerTone = ComponentStatus | 'loading'

function Banner({
  tone,
  title,
  subtitle,
}: {
  tone: BannerTone
  title: string
  subtitle: string
}) {
  const styles: Record<BannerTone, { ring: string; bg: string; dot: string; text: string }> = {
    operational: {
      ring: 'ring-emerald-500/30',
      bg: 'bg-emerald-500/5',
      dot: 'bg-emerald-400',
      text: 'text-emerald-300',
    },
    degraded: {
      ring: 'ring-amber-500/30',
      bg: 'bg-amber-500/5',
      dot: 'bg-amber-400',
      text: 'text-amber-300',
    },
    down: {
      ring: 'ring-rose-500/30',
      bg: 'bg-rose-500/5',
      dot: 'bg-rose-400',
      text: 'text-rose-300',
    },
    loading: {
      ring: 'ring-zinc-700',
      bg: 'bg-zinc-900/50',
      dot: 'bg-zinc-500',
      text: 'text-zinc-400',
    },
  }
  const s = styles[tone]
  return (
    <div
      className={`flex items-start gap-4 rounded-xl ${s.bg} p-5 ring-1 ${s.ring}`}
    >
      <span className="relative mt-1.5 flex h-2.5 w-2.5">
        {tone !== 'loading' && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${s.dot} opacity-50`}
          />
        )}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${s.dot}`} />
      </span>
      <div>
        <h2 className={`text-base font-medium ${s.text}`}>{title}</h2>
        {subtitle && (
          <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>
        )}
      </div>
    </div>
  )
}

function ComponentRow({ component }: { component: HealthComponent }) {
  const dot =
    component.status === 'operational'
      ? 'bg-emerald-400'
      : component.status === 'degraded'
        ? 'bg-amber-400'
        : 'bg-rose-400'
  const label =
    component.status === 'operational'
      ? 'Operational'
      : component.status === 'degraded'
        ? 'Degraded'
        : 'Down'
  const labelColor =
    component.status === 'operational'
      ? 'text-emerald-300'
      : component.status === 'degraded'
        ? 'text-amber-300'
        : 'text-rose-300'

  return (
    <li className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="truncate text-sm font-medium text-zinc-200">
            {component.name}
          </span>
        </div>
        {component.details && (
          <p className="ml-[18px] mt-1 truncate text-xs text-zinc-500">
            {component.details}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-baseline gap-4 text-right">
        <span className="font-mono text-xs tabular-nums text-zinc-400">
          {component.latency_ms}ms
        </span>
        <span className={`text-xs font-medium ${labelColor}`}>{label}</span>
      </div>
    </li>
  )
}

function SkeletonRows() {
  return (
    <ul className="divide-y divide-white/5">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-center justify-between px-5 py-4">
          <div className="h-3 w-40 animate-pulse rounded bg-zinc-800" />
          <div className="h-3 w-16 animate-pulse rounded bg-zinc-800" />
        </li>
      ))}
    </ul>
  )
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Intelligence self-monitoring panel — capsule counts, acceptance rate,
// and the recent system_health_log entries.
// ---------------------------------------------------------------------------

function IntelligenceStatusPanel({ intel }: { intel: IntelligenceHealth | null }) {
  if (!intel) {
    return (
      <section className="rounded-xl border border-white/5 bg-zinc-900/40 p-5">
        <h2 className="text-sm font-medium text-zinc-300">Intelligence</h2>
        <p className="mt-2 text-sm text-zinc-500">Loading…</p>
      </section>
    )
  }

  const accepted = intel.insights.acceptance_rate_30d
  const acceptedPct = accepted == null ? null : Math.round(accepted * 100)
  const acceptedLabel =
    acceptedPct == null ? '—' : `${acceptedPct}%`
  const acceptedTone =
    acceptedPct == null
      ? 'text-zinc-400'
      : acceptedPct < 20
        ? 'text-amber-300'
        : 'text-emerald-300'

  const lastAnalysisAt = intel.last_analysis?.at ?? null

  return (
    <section className="rounded-xl border border-white/5 bg-zinc-900/40 p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-zinc-300">Intelligence</h2>
        <span className="text-xs text-zinc-500">
          {lastAnalysisAt ? `Last run ${formatRelativeShort(lastAnalysisAt)}` : 'Never analyzed'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Capsules"
          value={intel.capsules.total.toString()}
          hint={`${intel.capsules.by_status.confirmed ?? 0} confirmed`}
        />
        <Stat
          label="Insights"
          value={(intel.insights.by_status.pending ?? 0).toString()}
          hint="pending"
        />
        <Stat
          label="Events 30d"
          value={intel.events_30d.toString()}
          hint="signals captured"
        />
        <Stat
          label="Acceptance"
          value={acceptedLabel}
          hint="last 30d"
          valueClassName={acceptedTone}
        />
      </div>

      {Object.keys(intel.capsules.by_type).length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(intel.capsules.by_type).map(([type, count]) => (
            <span
              key={type}
              className="rounded-full border border-violet-500/20 bg-violet-500/5 px-2.5 py-0.5 text-xs text-violet-200"
            >
              {prettyPattern(type)} · {count}
            </span>
          ))}
        </div>
      )}

      <div className="mt-5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Recent activity
        </h3>
        {intel.recent_log.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No analysis events yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-white/5 overflow-hidden rounded-lg border border-white/5">
            {intel.recent_log.slice(0, 8).map((l, i) => (
              <li
                key={`${l.created_at}-${i}`}
                className="flex items-center justify-between gap-3 bg-zinc-950/30 px-3 py-2 text-xs"
              >
                <span className={`shrink-0 font-mono ${logTone(l.event_type)}`}>
                  {l.event_type}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-400">
                  {summarizeLog(l.event_type, l.details)}
                </span>
                <span className="shrink-0 font-mono text-zinc-500">
                  {formatRelativeShort(l.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
  valueClassName,
}: {
  label: string
  value: string
  hint?: string
  valueClassName?: string
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-zinc-950/40 p-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-medium tabular-nums ${
          valueClassName ?? 'text-zinc-100'
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-zinc-500">{hint}</div>}
    </div>
  )
}

function prettyPattern(type: string): string {
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function logTone(eventType: string): string {
  if (
    eventType === 'degradation_detected' ||
    eventType === 'rollback_triggered' ||
    eventType === 'low_acceptance_rate' ||
    eventType === 'capsule_staled'
  ) {
    return 'text-amber-300'
  }
  if (eventType === 'capsule_promoted' || eventType === 'insight_generated') {
    return 'text-emerald-300'
  }
  return 'text-violet-300'
}

function summarizeLog(
  eventType: string,
  details: Record<string, unknown>,
): string {
  switch (eventType) {
    case 'analysis_run': {
      const d = details as {
        patterns_found?: number
        capsules_inserted?: number
        capsules_promoted?: number
      }
      return `${d.patterns_found ?? 0} patterns · ${d.capsules_promoted ?? 0} promoted`
    }
    case 'capsule_promoted':
    case 'capsule_staled': {
      const d = details as { pattern_type?: string; pattern_key?: string }
      return `${d.pattern_type ?? '—'}/${d.pattern_key ?? '—'}`
    }
    case 'insight_generated': {
      const d = details as { insight_type?: string; insight_key?: string }
      return `${d.insight_type ?? '—'} · ${d.insight_key ?? ''}`
    }
    case 'low_acceptance_rate': {
      const d = details as { acceptance_rate?: number }
      const rate =
        typeof d.acceptance_rate === 'number'
          ? Math.round(d.acceptance_rate * 100)
          : null
      return rate != null ? `${rate}% — throttling generation` : 'throttling'
    }
    case 'parameter_tuned': {
      const d = details as { parameter?: string; from?: unknown; to?: unknown }
      return `${d.parameter ?? '—'}: ${String(d.from)} → ${String(d.to)}`
    }
    default:
      return JSON.stringify(details).slice(0, 80)
  }
}

function formatRelativeShort(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  const m = Math.round(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}
