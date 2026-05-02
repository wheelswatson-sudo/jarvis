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

  const visible = useMemo(
    () => contacts.slice(0, pageSize),
    [contacts, pageSize],
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          {selectMode ? (
            <>
              <span className="tabular-nums">
                {selected.size} / {MAX_BATCH} selected
              </span>
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={clearSelection}
                  className="text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline"
                  disabled={isPending}
                >
                  clear
                </button>
              )}
            </>
          ) : (
            <span className="text-zinc-400">
              Showing {visible.length} of {contacts.length}
            </span>
          )}
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
              className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm shadow-indigo-500/20 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-400 disabled:opacity-50"
          >
            {selectMode ? 'Cancel' : 'Select to enrich'}
          </button>
        </div>
      </div>

      {!apolloConnected && selectMode && (
        <p className="text-xs text-amber-600">
          Apollo isn&apos;t connected.{' '}
          <Link href="/settings" className="underline">
            Add your API key in Settings
          </Link>{' '}
          to enable enrichment.
        </p>
      )}
      {statusMsg && <p className="text-xs text-emerald-600">{statusMsg}</p>}
      {errorMsg && <p className="text-xs text-rose-600">{errorMsg}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((c) => {
          const isSelected = selected.has(c.id)
          const atLimit = selected.size >= MAX_BATCH && !isSelected
          const cardBase =
            'group relative rounded-lg border p-4 transition-colors'
          const cardTone = isSelected
            ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500/30'
            : 'border-zinc-200 bg-white hover:border-zinc-300'
          const inner = (
            <>
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <div className="truncate font-medium">{contactName(c)}</div>
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
                  className={`absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded border ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-500 text-white'
                      : 'border-zinc-300 bg-white text-transparent'
                  }`}
                  aria-hidden
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
    </div>
  )
}
