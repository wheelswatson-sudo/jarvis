'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { HalfLifeGauge, SentimentSlope } from './Gauge'
import { CadenceBadge } from './CadenceBadge'
import { Tooltip, HelpDot } from './Tooltip'
import { useToast } from './Toast'
import {
  contactName,
  pipelineStageColor,
  tierColor,
  tierLabel,
} from '../lib/format'
import { getCadenceInfo } from '../lib/contacts/cadence'
import { TIER_GLOSSARY, HALF_LIFE_HELP } from '../lib/glossary'
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  type Contact,
  type PipelineStage,
} from '../lib/types'

type SortMode = 'default' | 'overdue'

const MAX_BATCH = 10

type ContactWithStats = Contact & { open_commitments: number }

type EnrichResultItem = {
  contact_id: string
  status: 'enriched' | 'not_found' | 'skipped' | 'error'
  fields_updated?: string[]
  error?: string
}

type EnrichResponse = {
  requested?: number
  processed?: number
  enriched?: number
  not_found?: number
  skipped?: number
  errors?: number
  truncated?: boolean
  results?: EnrichResultItem[]
  error?: string
  code?: string
}

type Props = {
  contacts: ContactWithStats[]
  apolloConnected: boolean
  pageSize?: number
}

function initials(c: Contact): string {
  const parts = [c.first_name, c.last_name].filter(Boolean) as string[]
  if (parts.length > 0) {
    return parts
      .map((p) => p[0]!)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  }
  if (c.email) return c.email[0]!.toUpperCase()
  return '·'
}

export function ContactsGrid({
  contacts,
  apolloConnected,
  pageSize = 30,
}: Props) {
  const router = useRouter()
  const toast = useToast()
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isPending, startTransition] = useTransition()
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('default')
  const [stageFilter, setStageFilter] = useState<PipelineStage | null>(null)
  const [displayCount, setDisplayCount] = useState(pageSize)

  // Per-stage counts power both the filter pills and the "no contacts in this
  // status" empty state. Recomputed only when contacts change so toggling
  // the filter doesn't reshuffle counts.
  const stageCounts = useMemo(() => {
    const counts: Record<PipelineStage, number> = {
      lead: 0,
      warm: 0,
      active: 0,
      committed: 0,
      closed: 0,
      dormant: 0,
    }
    for (const c of contacts) {
      if (c.pipeline_stage && c.pipeline_stage in counts) {
        counts[c.pipeline_stage]++
      }
    }
    return counts
  }, [contacts])

  const hasAnyStaged = useMemo(
    () => contacts.some((c) => c.pipeline_stage != null),
    [contacts],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = q
      ? contacts.filter((c) => {
          const haystack = [
            contactName(c),
            c.email ?? '',
            c.title ?? '',
            c.company ?? '',
          ]
            .join(' ')
            .toLowerCase()
          return haystack.includes(q)
        })
      : contacts

    if (stageFilter) {
      list = list.filter((c) => c.pipeline_stage === stageFilter)
    }

    if (sortMode === 'overdue') {
      const now = Date.now()
      const scored = list
        .map((c) => {
          const info = getCadenceInfo(c.tier, c.last_interaction_at, now)
          // Surface only contacts that are approaching or overdue, with a known
          // tier — "default" mode keeps the LTV-based ordering for everyone else.
          if (info.state !== 'overdue' && info.state !== 'approaching') {
            return null
          }
          // Higher score = more urgent. Overdue T1 outranks overdue T3.
          const overshoot =
            info.daysSinceLast == null || info.cadenceDays == null
              ? 0
              : info.daysSinceLast - info.cadenceDays
          const tierWeight = c.tier === 1 ? 1000 : c.tier === 2 ? 100 : 10
          const score =
            (info.state === 'overdue' ? 10000 : 0) + tierWeight + overshoot
          return { c, score }
        })
        .filter((x): x is { c: ContactWithStats; score: number } => x !== null)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c)
      list = scored
    }

    return list
  }, [contacts, query, sortMode, stageFilter])

  // Count contacts the cadence engine couldn't evaluate (no tier set).
  // Surfaced in the empty-state copy so the user knows we silently dropped
  // them rather than confidently claiming "everyone is on cadence".
  const untieredCount = useMemo(
    () =>
      sortMode === 'overdue'
        ? contacts.filter((c) => c.tier == null).length
        : 0,
    [contacts, sortMode],
  )

  const visible = useMemo(
    () => filtered.slice(0, displayCount),
    [filtered, displayCount],
  )
  const hasMore = filtered.length > visible.length

  function toggleSelectMode() {
    setSelectMode((s) => {
      const next = !s
      if (!next) setSelected(new Set())
      return next
    })
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        if (next.size >= MAX_BATCH) return prev
        next.add(id)
      }
      return next
    })
  }

  function clearSelection() {
    setSelected(new Set())
  }

  function enrichSelected() {
    if (selected.size === 0) return
    const ids = Array.from(selected)
    startTransition(async () => {
      try {
        const res = await fetch('/api/contacts/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact_ids: ids }),
        })
        const raw: EnrichResponse = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(raw.error ?? `Enrichment failed (HTTP ${res.status})`)
          return
        }
        const e = raw.enriched ?? 0
        const nf = raw.not_found ?? 0
        const sk = raw.skipped ?? 0
        const er = raw.errors ?? 0
        const parts: string[] = []
        if (nf) parts.push(`${nf} not found in Apollo`)
        if (sk) parts.push(`${sk} skipped (already enriched)`)
        if (er) parts.push(`${er} errored`)
        const detail = parts.length ? ` · ${parts.join(', ')}` : ''
        if (e > 0) {
          toast.success(`Enriched ${e} of ${ids.length} contacts${detail}`)
        } else {
          toast.info(`No contacts enriched${detail || ''}`)
        }
        setSelected(new Set())
        setSelectMode(false)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Enrichment failed.')
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3">
          <div className="relative w-full max-w-xs">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-500"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, company…"
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] py-2 pl-9 pr-3 text-sm text-zinc-100 transition-colors placeholder:text-zinc-500 focus:border-violet-500/50 focus:outline-none"
            />
          </div>
          <div className="text-xs text-zinc-500">
            {selectMode ? (
              <>
                <span className="tabular-nums text-zinc-300">
                  {selected.size} / {MAX_BATCH}
                </span>{' '}
                selected
                {selected.size > 0 && (
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="ml-2 text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
                    disabled={isPending}
                  >
                    clear
                  </button>
                )}
              </>
            ) : (
              <span className="text-zinc-500">
                <span className="text-zinc-300">{visible.length}</span> of{' '}
                {filtered.length}
                {filtered.length !== contacts.length && (
                  <span className="text-zinc-600"> · {contacts.length} total</span>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-1 text-xs">
            <button
              type="button"
              onClick={() => setSortMode('default')}
              className={`rounded-md px-2.5 py-1 transition-all ${
                sortMode === 'default'
                  ? 'bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/15 text-white ring-1 ring-inset ring-violet-500/30'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setSortMode('overdue')}
              className={`rounded-md px-2.5 py-1 transition-all ${
                sortMode === 'overdue'
                  ? 'bg-gradient-to-br from-rose-500/20 to-fuchsia-500/15 text-white ring-1 ring-inset ring-rose-500/30'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              Overdue for contact
            </button>
          </div>
          {selectMode && (
            <button
              type="button"
              onClick={enrichSelected}
              disabled={isPending || selected.size === 0 || !apolloConnected}
              title={
                !apolloConnected
                  ? 'Connect Apollo in Settings first'
                  : undefined
              }
              className="rounded-lg aiea-cta px-3.5 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isPending
                ? 'Enriching…'
                : `Enrich ${selected.size || ''} with Apollo`}
            </button>
          )}
          <button
            type="button"
            onClick={toggleSelectMode}
            disabled={isPending}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.15] hover:text-white disabled:opacity-50"
          >
            {selectMode ? 'Cancel' : 'Select to enrich'}
          </button>
        </div>
      </div>

      {hasAnyStaged && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
            Status
          </span>
          <button
            type="button"
            onClick={() => setStageFilter(null)}
            aria-pressed={stageFilter === null}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
              stageFilter === null
                ? 'bg-white/[0.08] text-zinc-100 ring-1 ring-inset ring-white/15'
                : 'text-zinc-500 hover:text-zinc-200'
            }`}
          >
            Any
          </button>
          {PIPELINE_STAGES.map((s) => {
            const count = stageCounts[s]
            if (count === 0) return null
            const active = stageFilter === s
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStageFilter(active ? null : s)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
                  active
                    ? pipelineStageColor(s)
                    : 'bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 ring-1 ring-inset ring-white/[0.06]'
                }`}
              >
                <span>{PIPELINE_STAGE_LABELS[s]}</span>
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            )
          })}
        </div>
      )}

      {!apolloConnected && selectMode && (
        <p className="text-xs text-amber-300">
          Apollo isn&apos;t connected.{' '}
          <Link href="/settings" className="underline">
            Add your API key in Settings
          </Link>{' '}
          to enable enrichment.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 aiea-stagger">
        {visible.map((c) => {
          const isSelected = selected.has(c.id)
          const atLimit = selected.size >= MAX_BATCH && !isSelected
          const cardBase =
            'group relative overflow-hidden rounded-2xl p-4 transition-all duration-300'
          const cardTone = isSelected
            ? 'aiea-glass aiea-ring border-violet-500/40 shadow-[0_0_0_1px_rgba(139,92,246,0.5)]'
            : 'aiea-glass aiea-lift'
          const inner = (
            <>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-12 -top-12 h-28 w-28 rounded-full bg-gradient-to-br from-indigo-500/0 via-violet-500/0 to-fuchsia-500/0 opacity-0 blur-2xl transition-opacity duration-500 group-hover:from-indigo-500/15 group-hover:via-violet-500/10 group-hover:to-fuchsia-500/15 group-hover:opacity-100"
              />
              <div className="relative flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar contact={c} />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-zinc-100">
                      {contactName(c)}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {[c.title, c.company].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Tooltip
                    content={tierTooltipContent(c.tier)}
                    side="left"
                  >
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide ${tierColor(c.tier)}`}
                    >
                      {tierLabel(c.tier)}
                    </span>
                  </Tooltip>
                  {c.pipeline_stage && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide ${pipelineStageColor(c.pipeline_stage)}`}
                    >
                      {PIPELINE_STAGE_LABELS[c.pipeline_stage]}
                    </span>
                  )}
                </div>
              </div>
              <div className="relative mt-4">
                <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-wider text-zinc-500">
                  <span className="inline-flex items-center gap-1.5">
                    Half-life
                    <HelpDot content={HALF_LIFE_HELP} />
                  </span>
                  <span className="tabular-nums text-zinc-400">
                    {c.half_life_days != null
                      ? `${c.half_life_days.toFixed(0)}d`
                      : '—'}
                  </span>
                </div>
                <HalfLifeGauge days={c.half_life_days} />
              </div>
              <div className="relative mt-3 flex items-center justify-between text-[11px] text-zinc-500">
                <SentimentSlope slope={c.sentiment_slope} />
                <span className="tabular-nums">
                  {c.open_commitments > 0
                    ? `${c.open_commitments} open`
                    : 'no commitments'}
                </span>
              </div>
              <div className="relative mt-2">
                <CadenceBadge
                  tier={c.tier}
                  lastInteractionAt={c.last_interaction_at}
                  variant="compact"
                />
              </div>
            </>
          )
          if (selectMode) {
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleSelected(c.id)}
                disabled={atLimit || isPending}
                className={`${cardBase} ${cardTone} text-left disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span
                  className={`absolute right-3 top-3 z-10 inline-flex h-5 w-5 items-center justify-center rounded-md text-[11px] font-semibold transition-all ${
                    isSelected
                      ? 'bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/40'
                      : 'border border-white/[0.08] bg-white/[0.02] text-transparent'
                  }`}
                  aria-hidden="true"
                >
                  ✓
                </span>
                {inner}
              </button>
            )
          }
          return (
            <Link
              key={c.id}
              href={`/contacts/${c.id}`}
              className={`${cardBase} ${cardTone}`}
            >
              {inner}
            </Link>
          )
        })}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() =>
              setDisplayCount((n) => Math.min(n + pageSize, filtered.length))
            }
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.18] hover:text-white"
          >
            Show {Math.min(pageSize, filtered.length - visible.length)} more
            <span className="ml-1.5 text-zinc-500">
              ({filtered.length - visible.length} hidden)
            </span>
          </button>
        </div>
      )}

      {visible.length === 0 && (
        <div className="rounded-2xl aiea-glass p-10 text-center">
          <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 ring-1 ring-inset ring-white/10 text-violet-200">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          </div>
          {sortMode === 'overdue' ? (
            <>
              <p className="text-sm font-medium text-zinc-200">
                Nobody is overdue for contact
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Network is on cadence.
                {untieredCount > 0 && (
                  <>
                    {' '}
                    {untieredCount} contact{untieredCount === 1 ? '' : 's'}{' '}
                    have no tier set — set tiers to evaluate cadence.
                  </>
                )}
              </p>
            </>
          ) : query ? (
            <>
              <p className="text-sm font-medium text-zinc-200">
                No contacts match &ldquo;{query}&rdquo;
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Try a different name, email, or company.{' '}
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="text-violet-300 underline-offset-2 hover:underline"
                >
                  Clear search
                </button>
              </p>
            </>
          ) : stageFilter ? (
            <>
              <p className="text-sm font-medium text-zinc-200">
                No contacts tagged{' '}
                <span className="text-zinc-100">
                  {PIPELINE_STAGE_LABELS[stageFilter]}
                </span>
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Open a contact and set their status, or{' '}
                <button
                  type="button"
                  onClick={() => setStageFilter(null)}
                  className="text-violet-300 underline-offset-2 hover:underline"
                >
                  show all
                </button>
                .
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-zinc-200">
                No contacts to show
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Import contacts or connect Google to seed your network.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function tierTooltipContent(tier: number | null | undefined) {
  if (tier === 1 || tier === 2 || tier === 3) {
    const meta = TIER_GLOSSARY[`T${tier}` as 'T1' | 'T2' | 'T3']
    return (
      <span>
        <span className="font-medium text-zinc-100">
          Tier {tier} · {meta.label}
        </span>
        <br />
        {meta.description}
      </span>
    )
  }
  return (
    <span>
      <span className="font-medium text-zinc-100">No tier</span>
      <br />
      Open the contact and tap T1/T2/T3 to set how closely AIEA tracks them.
    </span>
  )
}

function Avatar({ contact }: { contact: Contact }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500/30 via-violet-500/25 to-fuchsia-500/30 text-[11px] font-semibold text-white ring-1 ring-inset ring-white/10"
    >
      {initials(contact)}
    </span>
  )
}
