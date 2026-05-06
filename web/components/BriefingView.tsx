'use client'

import Link from 'next/link'
import { useState } from 'react'
import { formatRelative } from '../lib/format'
import type {
  BriefingItem,
  BriefingPayload,
  BriefingSections,
  BriefingUrgency,
} from '../lib/intelligence/daily-briefing'

type CachedBriefing = {
  id: string
  user_id: string
  briefing_date: string
  payload: BriefingPayload
  markdown: string
  generated_at: string
}

type Props = { initial: CachedBriefing | null }

const SECTION_META: Array<{
  key: keyof BriefingSections
  title: string
  blurb: string
  icon: string
}> = [
  {
    key: 'personalized_observations',
    title: 'AI observations',
    blurb: 'Patterns the rules can’t see — grounded in your profile and relationship graph.',
    icon: 'sparkles',
  },
  {
    key: 'todays_meetings',
    title: "Today's meetings",
    blurb: 'Walk in prepared.',
    icon: 'calendar',
  },
  {
    key: 'overdue_commitments',
    title: 'Overdue commitments',
    blurb: 'You said you would. The clock is past.',
    icon: 'flag',
  },
  {
    key: 'cooling_relationships',
    title: 'Cooling relationships',
    blurb: 'Sentiment is sliding — interrupt the trend.',
    icon: 'thermometer',
  },
  {
    key: 'social_changes',
    title: 'Recent social changes',
    blurb: 'Fresh updates the Chrome extension surfaced.',
    icon: 'rss',
  },
  {
    key: 'reciprocity_flags',
    title: 'Reciprocity flags',
    blurb: 'Conversations where you do all the reaching.',
    icon: 'scale',
  },
  {
    key: 'stale_relationships',
    title: 'Dormant high-value relationships',
    blurb: 'Strong ties gone quiet. Reactivation = leverage.',
    icon: 'moon',
  },
  {
    key: 'connector_opportunities',
    title: 'Connector opportunities',
    blurb: 'Pairings worth a warm introduction.',
    icon: 'link',
  },
]

function todayWords(date?: string | null): string {
  const d = date ? new Date(date + 'T00:00:00') : new Date()
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

export function BriefingView({ initial }: Props) {
  const [briefing, setBriefing] = useState<CachedBriefing | null>(initial)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/intelligence/daily-briefing', {
        method: 'POST',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      const data = (await res.json()) as { briefing: CachedBriefing | null }
      if (data.briefing) setBriefing(data.briefing)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate')
    } finally {
      setGenerating(false)
    }
  }

  const payload = briefing?.payload ?? null
  const totalActions = payload?.ranked_actions.length ?? 0

  return (
    <div className="space-y-8 animate-fade-up">
      {/* Newspaper masthead */}
      <header className="relative overflow-hidden rounded-2xl aiea-glass-strong">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/10 via-violet-500/5 to-fuchsia-500/10"
        />
        <div className="relative flex flex-col gap-6 p-6 sm:p-8 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/25 bg-violet-500/[0.08] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-violet-200">
              <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 animate-pulse" />
              Daily briefing
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance aiea-gradient-text sm:text-4xl">
              {todayWords(payload?.briefing_date ?? null)}
            </h1>
            <p className="mt-2 max-w-xl text-sm text-zinc-400 sm:text-base">
              {briefing
                ? totalActions > 0
                  ? `${totalActions} action${totalActions === 1 ? '' : 's'} ranked. Generated ${formatRelative(briefing.generated_at)}.`
                  : `Network is in a steady state. Generated ${formatRelative(briefing.generated_at)}.`
                : 'No briefing yet today. Generate one to see what your network needs from you.'}
            </p>
          </div>
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl aiea-cta px-5 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {generating ? (
              <>
                <Spinner /> Generating…
              </>
            ) : briefing ? (
              <>
                <RefreshIcon /> Regenerate
              </>
            ) : (
              <>
                <SparklesIcon /> Generate briefing
              </>
            )}
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.08] px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {payload ? (
        <BriefingBody payload={payload} />
      ) : (
        <div className="rounded-2xl aiea-glass p-12 text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/20 via-violet-500/20 to-fuchsia-500/20 ring-1 ring-inset ring-white/10 text-violet-200 animate-float">
            <SparklesIcon />
          </div>
          <h2 className="text-base font-medium text-zinc-100">
            No briefing yet
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
            Click <span className="text-zinc-300">Generate briefing</span> to
            assemble today&apos;s intelligence — meetings, overdue commitments,
            and cooling relationships.
          </p>
        </div>
      )}
    </div>
  )
}

function BriefingBody({ payload }: { payload: BriefingPayload }) {
  const empty = payload.ranked_actions.length === 0
  return (
    <div className="space-y-8">
      {empty ? (
        <div className="rounded-2xl aiea-glass p-10 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/20 text-emerald-300">
            <CheckIcon />
          </div>
          <p className="text-sm text-zinc-300">
            Nothing on fire. Use the slack to invest in something compounding.
          </p>
        </div>
      ) : (
        <RankedList items={payload.ranked_actions} />
      )}

      <div className="grid gap-4 md:grid-cols-2 aiea-stagger">
        {SECTION_META.map((meta) => (
          <SectionCard
            key={meta.key}
            title={meta.title}
            blurb={meta.blurb}
            icon={meta.icon}
            items={payload.sections[meta.key] ?? []}
          />
        ))}
      </div>

      {payload.notes.length > 0 && (
        <div className="rounded-xl aiea-glass p-4 text-xs text-zinc-400">
          {payload.notes.map((n, i) => (
            <div key={i} className="leading-relaxed">
              {n}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RankedList({ items }: { items: BriefingItem[] }) {
  const top = items.slice(0, 8)
  return (
    <div className="rounded-2xl aiea-glass-strong p-6">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-400">
            Top of the list
          </h2>
          <p className="mt-1 text-base font-medium text-zinc-100">
            Ranked actions
          </p>
        </div>
        {items.length > top.length && (
          <span className="text-xs text-zinc-500">
            <span className="tabular-nums text-zinc-300">{top.length}</span> of{' '}
            <span className="tabular-nums">{items.length}</span>
          </span>
        )}
      </div>
      <ol className="space-y-2 aiea-stagger">
        {top.map((it, idx) => (
          <li key={it.id}>
            <ItemRow item={it} index={idx + 1} />
          </li>
        ))}
      </ol>
    </div>
  )
}

function SectionCard({
  title,
  blurb,
  icon,
  items,
}: {
  title: string
  blurb: string
  icon: string
  items: BriefingItem[]
}) {
  return (
    <div className="rounded-2xl aiea-glass aiea-lift p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 ring-1 ring-inset ring-white/10 text-violet-200">
          <SectionIcon name={icon} />
        </span>
        <div>
          <h3 className="text-sm font-medium text-zinc-100">{title}</h3>
          <p className="mt-0.5 text-xs text-zinc-500">{blurb}</p>
        </div>
        <span className="ml-auto rounded-full border border-white/[0.06] bg-white/[0.02] px-2 py-0.5 text-[10px] tabular-nums text-zinc-400">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing here.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => (
            <li key={it.id}>
              <ItemRow item={it} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ItemRow({ item, index }: { item: BriefingItem; index?: number }) {
  const inner = (
    <div className="group flex items-start gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-3 transition-all hover:border-white/[0.12] hover:bg-white/[0.04]">
      <UrgencyDot urgency={item.urgency} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {index != null && (
            <span className="font-mono text-[10px] tabular-nums text-zinc-600">
              {index.toString().padStart(2, '0')}
            </span>
          )}
          <span className="truncate text-sm font-medium text-zinc-100 group-hover:text-white">
            {item.action}
          </span>
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-zinc-400">
          {item.why}
        </div>
        {item.contact_name && (
          <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-zinc-500">
            <span className="h-1 w-1 rounded-full bg-zinc-600" />
            {item.contact_name}
          </div>
        )}
      </div>
      <CategoryTag category={item.category} />
    </div>
  )
  if (item.href) {
    return (
      <Link href={item.href} className="block">
        {inner}
      </Link>
    )
  }
  return inner
}

function UrgencyDot({ urgency }: { urgency: BriefingUrgency }) {
  const cls =
    urgency === 'high'
      ? 'bg-fuchsia-400 shadow-[0_0_10px_rgba(232,121,249,0.7)]'
      : urgency === 'medium'
        ? 'bg-violet-400 shadow-[0_0_10px_rgba(167,139,250,0.55)]'
        : 'bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,0.5)]'
  return (
    <span
      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${cls}`}
      aria-label={urgency}
    />
  )
}

function CategoryTag({ category }: { category: BriefingItem['category'] }) {
  const label =
    category === 'meeting'
      ? 'Meeting'
      : category === 'overdue'
        ? 'Overdue'
        : category === 'cooling'
          ? 'Cooling'
          : category === 'reciprocity'
            ? 'One-sided'
            : category === 'stale'
              ? 'Dormant'
              : category === 'social'
                ? 'Social'
                : 'Connector'
  return (
    <span className="hidden shrink-0 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400 sm:inline-block">
      {label}
    </span>
  )
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="animate-[aiea-spin-slow_0.9s_linear_infinite]"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 11-6.22-8.56" />
    </svg>
  )
}
function RefreshIcon() {
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
      <path d="M21 12a9 9 0 11-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
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
function CheckIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 12 5 5L20 6" />
    </svg>
  )
}

function SectionIcon({ name }: { name: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }
  switch (name) {
    case 'sparkles':
      return (
        <svg {...common}>
          <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
          <path d="M19 16l.6 1.6L21 18l-1.4.4L19 20l-.6-1.6L17 18l1.4-.4z" />
        </svg>
      )
    case 'calendar':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 3v4M16 3v4" />
        </svg>
      )
    case 'flag':
      return (
        <svg {...common}>
          <path d="M5 21V4h12l-2 4 2 4H5" />
        </svg>
      )
    case 'thermometer':
      return (
        <svg {...common}>
          <path d="M14 4a2 2 0 10-4 0v10.5a4 4 0 104 0V4z" />
          <path d="M12 14V8" />
        </svg>
      )
    case 'rss':
      return (
        <svg {...common}>
          <path d="M5 5a14 14 0 0114 14M5 11a8 8 0 018 8M6 18a1 1 0 100 2 1 1 0 000-2z" />
        </svg>
      )
    case 'scale':
      return (
        <svg {...common}>
          <path d="M12 3v18M5 7l7-2 7 2M3 11l4-4 4 4M13 11l4-4 4 4" />
        </svg>
      )
    case 'moon':
      return (
        <svg {...common}>
          <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
        </svg>
      )
    case 'link':
    default:
      return (
        <svg {...common}>
          <path d="M10 13a5 5 0 007 0l3-3a5 5 0 10-7-7l-1.5 1.5" />
          <path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 107 7l1.5-1.5" />
        </svg>
      )
  }
}
