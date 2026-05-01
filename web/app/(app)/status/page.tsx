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

const REFRESH_MS = 30_000
const SENTRY_URL = process.env.NEXT_PUBLIC_SENTRY_DASHBOARD_URL ?? null

export default function StatusPage() {
  const [data, setData] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)

  async function fetchHealth() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      const json = (await res.json()) as HealthResponse
      setData(json)
      setError(null)
      setLastFetched(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch health')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
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
