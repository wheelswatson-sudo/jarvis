import type { ReactNode } from 'react'

export function Card({
  children,
  className = '',
  interactive = false,
  glow = false,
}: {
  children: ReactNode
  className?: string
  interactive?: boolean
  glow?: boolean
}) {
  return (
    <div
      className={[
        'relative rounded-2xl p-5',
        'aiea-glass',
        interactive ? 'aiea-lift' : '',
        glow ? 'aiea-ring' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}

const TONE: Record<
  'indigo' | 'violet' | 'fuchsia' | 'emerald' | 'amber' | 'rose',
  { dot: string; bar: string; text: string }
> = {
  indigo: {
    dot: 'bg-indigo-400',
    bar: 'from-indigo-500 to-violet-500',
    text: 'text-indigo-300',
  },
  violet: {
    dot: 'bg-violet-400',
    bar: 'from-violet-500 to-fuchsia-500',
    text: 'text-violet-300',
  },
  fuchsia: {
    dot: 'bg-fuchsia-400',
    bar: 'from-fuchsia-500 to-rose-500',
    text: 'text-fuchsia-300',
  },
  emerald: {
    dot: 'bg-emerald-400',
    bar: 'from-emerald-500 to-teal-500',
    text: 'text-emerald-300',
  },
  amber: {
    dot: 'bg-amber-400',
    bar: 'from-amber-500 to-orange-500',
    text: 'text-amber-300',
  },
  rose: {
    dot: 'bg-rose-400',
    bar: 'from-rose-500 to-fuchsia-500',
    text: 'text-rose-300',
  },
}

export function MetricCard({
  label,
  value,
  hint,
  trend,
  tone = 'violet',
  icon,
}: {
  label: string
  value: string
  hint?: string
  trend?: { delta: string; direction: 'up' | 'down' | 'flat' }
  tone?: keyof typeof TONE
  icon?: ReactNode
}) {
  const t = TONE[tone]
  return (
    <div className="group relative overflow-hidden rounded-2xl aiea-glass aiea-lift p-5">
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br ${t.bar} opacity-[0.08] blur-2xl transition-opacity duration-300 group-hover:opacity-[0.18]`}
      />
      <div className="relative flex items-start justify-between gap-3">
        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
          {label}
        </div>
        {icon && (
          <span className={`grid h-7 w-7 place-items-center rounded-lg bg-white/[0.04] ${t.text}`}>
            {icon}
          </span>
        )}
      </div>
      <div className="relative mt-3 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight tabular-nums text-zinc-50">
          {value}
        </span>
        {trend && <TrendChip {...trend} />}
      </div>
      {hint && (
        <div className="relative mt-1.5 text-[11px] text-zinc-500">{hint}</div>
      )}
      <div className="relative mt-4 h-0.5 w-full overflow-hidden rounded-full bg-white/[0.04]">
        <div
          className={`h-full w-1/3 bg-gradient-to-r ${t.bar} opacity-70 transition-all duration-500 group-hover:w-2/3`}
        />
      </div>
    </div>
  )
}

function TrendChip({
  delta,
  direction,
}: {
  delta: string
  direction: 'up' | 'down' | 'flat'
}) {
  const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→'
  const cls =
    direction === 'up'
      ? 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30'
      : direction === 'down'
        ? 'text-rose-300 bg-rose-500/10 ring-rose-500/30'
        : 'text-zinc-300 bg-white/5 ring-white/10'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset tabular-nums ${cls}`}
    >
      {arrow} {delta}
    </span>
  )
}

export function SectionHeader({
  title,
  subtitle,
  action,
  eyebrow,
}: {
  title: ReactNode
  subtitle?: string
  action?: ReactNode
  eyebrow?: string
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow && (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-400">
            <span className="h-1 w-1 rounded-full bg-gradient-to-r from-indigo-400 to-fuchsia-400" />
            {eyebrow}
          </div>
        )}
        <h2 className="text-lg font-medium tracking-tight text-zinc-100 sm:text-xl">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1 max-w-xl text-sm text-zinc-400">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  )
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-2">
      <div>
        {eyebrow && (
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-violet-500/25 bg-violet-500/[0.08] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-violet-200">
            <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400" />
            {eyebrow}
          </div>
        )}
        <h1 className="text-3xl font-semibold tracking-tight aiea-gradient-text sm:text-4xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-sm text-zinc-400 sm:text-base">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode
  title: string
  body?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="rounded-2xl aiea-glass p-10 text-center">
      {icon && (
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 ring-1 ring-inset ring-white/10 text-violet-200">
          {icon}
        </div>
      )}
      <h3 className="text-base font-medium text-zinc-100">{title}</h3>
      {body && (
        <p className="mx-auto mt-1.5 max-w-md text-sm text-zinc-400">{body}</p>
      )}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}
