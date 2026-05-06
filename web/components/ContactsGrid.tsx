'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { HalfLifeGauge, SentimentSlope } from './Gauge'
import { contactName, tierColor, tierLabel } from '../lib/format'
import type { Contact } from '../lib/types'

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
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isPending, startTransition] = useTransition()
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter((c) => {
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
  }, [contacts, query])

  const visible = useMemo(
    () => filtered.slice(0, pageSize),
    [filtered, pageSize],
  )

  function toggleSelectMode() {
    setSelectMode((s) => {
      const next = !s
      if (!next) setSelected(new Set())
      setStatusMsg(null)
      setErrorMsg(null)
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
    setStatusMsg(null)
    setErrorMsg(null)
  }

  function enrichSelected() {
    if (selected.size === 0) return
    setStatusMsg(null)
    setErrorMsg(null)
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
          setErrorMsg(raw.error ?? `Enrichment failed (HTTP ${res.status}).`)
          return
        }
        const e = raw.enriched ?? 0
        const nf = raw.not_found ?? 0
        const sk = raw.skipped ?? 0
        const er = raw.errors ?? 0
        setStatusMsg(
          `Enriched ${e} of ${ids.length}: ${nf} not found, ${sk} skipped, ${er} errors.`,
        )
        setSelected(new Set())
        setSelectMode(false)
        router.refresh()
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Enrichment failed.')
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

      {!apolloConnected && selectMode && (
        <p className="text-xs text-amber-300">
          Apollo isn&apos;t connected.{' '}
          <Link href="/settings" className="underline">
            Add your API key in Settings
          </Link>{' '}
          to enable enrichment.
        </p>
      )}
      {statusMsg && <p className="text-xs text-emerald-300">{statusMsg}</p>}
      {errorMsg && <p className="text-xs text-rose-300">{errorMsg}</p>}

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
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide ${tierColor(c.tier)}`}
                >
                  {tierLabel(c.tier)}
                </span>
              </div>
              <div className="relative mt-4">
                <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-wider text-zinc-500">
                  <span>Half-life</span>
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

      {visible.length === 0 && (
        <div className="rounded-2xl aiea-glass p-10 text-center text-sm text-zinc-500">
          No contacts match &ldquo;{query}&rdquo;.
        </div>
      )}
    </div>
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
