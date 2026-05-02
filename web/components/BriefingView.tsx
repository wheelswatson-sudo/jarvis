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
}> = [
  {
    key: 'todays_meetings',
    title: "Today's meetings",
    blurb: 'Walk in prepared.',
  },
  {
    key: 'overdue_commitments',
    title: 'Overdue commitments',
    blurb: 'You said you would. The clock is past.',
  },
  {
    key: 'cooling_relationships',
    title: 'Cooling relationships',
    blurb: 'Sentiment is sliding — interrupt the trend.',
  },
  {
    key: 'social_changes',
    title: 'Recent social changes',
    blurb: 'Fresh updates the Chrome extension surfaced.',
  },
  {
    key: 'reciprocity_flags',
    title: 'Reciprocity flags',
    blurb: 'Conversations where you do all the reaching.',
  },
  {
    key: 'stale_relationships',
    title: 'Dormant high-value relationships',
    blurb: 'Strong ties gone quiet. Reactivation = leverage.',
  },
  {
    key: 'connector_opportunities',
    title: 'Connector opportunities',
    blurb: 'Pairings worth a warm introduction.',
  },
]

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
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl shadow-violet-500/5">
      <div className="flex flex-col gap-4 border-b border-zinc-800 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500" />
            <h1 className="text-xl font-medium tracking-tight">
              Daily intelligence briefing
            </h1>
          </div>
          <p className="mt-1 text-sm text-zinc-400">
            {briefing
              ? `${totalActions} action${totalActions === 1 ? '' : 's'} for ${payload?.briefing_date}. Generated ${formatRelative(briefing.generated_at)}.`
              : 'No briefing yet. Generate one to see what the network needs from you today.'}
          </p>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-violet-500/30 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {generating ? 'Generating…' : briefing ? 'Regenerate briefing' : 'Generate briefing'}
        </button>
      </div>

      {error && (
        <div className="border-b border-zinc-800 bg-red-950/40 px-6 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {payload ? (
        <BriefingBody payload={payload} />
      ) : (
        <div className="p-10 text-center text-sm text-zinc-500">
          Click <span className="text-zinc-300">Generate briefing</span> to assemble today&apos;s intelligence.
        </div>
      )}
    </div>
  )
}

function BriefingBody({ payload }: { payload: BriefingPayload }) {
  const empty = payload.ranked_actions.length === 0
  return (
    <div className="space-y-6 p-6">
      {empty ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-400">
          Nothing on fire. Use the slack to invest in something compounding.
        </div>
      ) : (
        <RankedList items={payload.ranked_actions} />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {SECTION_META.map((meta) => (
          <SectionCard
            key={meta.key}
            title={meta.title}
            blurb={meta.blurb}
            items={payload.sections[meta.key]}
          />
        ))}
      </div>

      {payload.notes.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-400">
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
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-300">
            Ranked actions
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Top of the list first. Tap any item to jump to the contact.
          </p>
        </div>
        {items.length > top.length && (
          <span className="text-xs text-zinc-500">
            Showing {top.length} of {items.length}
          </span>
        )}
      </div>
      <ol className="space-y-2">
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
  items,
}: {
  title: string
  blurb: string
  items: BriefingItem[]
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="mb-3">
        <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
        <p className="mt-0.5 text-xs text-zinc-500">{blurb}</p>
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
    <div className="group flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 transition-colors hover:border-zinc-700 hover:bg-zinc-900">
      <UrgencyDot urgency={item.urgency} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {index != null && (
            <span className="tabular-nums text-xs text-zinc-500">
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
          <div className="mt-1 text-xs text-zinc-500">{item.contact_name}</div>
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
      ? 'bg-fuchsia-500 shadow-fuchsia-500/50'
      : urgency === 'medium'
        ? 'bg-violet-500 shadow-violet-500/50'
        : 'bg-indigo-500 shadow-indigo-500/50'
  return (
    <span
      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full shadow-md ${cls}`}
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
    <span className="hidden shrink-0 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400 sm:inline-block">
      {label}
    </span>
  )
}
