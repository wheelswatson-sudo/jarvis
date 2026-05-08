'use client'

import Link from 'next/link'
import { useEffect, useState, useTransition } from 'react'
import type { IntelligenceInsight } from '../lib/types'

type Mode = 'loading' | 'empty' | 'learning' | 'ready' | 'error'

const MIN_EVENTS_FOR_LEARNING = 5

export function IntelligencePanel() {
  const [insights, setInsights] = useState<IntelligenceInsight[] | null>(null)
  const [eventsCount, setEventsCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [pending, start] = useTransition()
  const [removing, setRemoving] = useState<Set<string>>(new Set())

  async function load() {
    try {
      const [insightsRes, healthRes] = await Promise.all([
        fetch('/api/intelligence/insights', { cache: 'no-store' }),
        fetch('/api/intelligence/health', { cache: 'no-store' }),
      ])
      if (!insightsRes.ok) {
        const detail = await insightsRes
          .json()
          .then((j: { error?: string; code?: string }) =>
            j.error ? `${insightsRes.status} ${j.code ?? ''} ${j.error}`.trim() : `${insightsRes.status}`,
          )
          .catch(() => `${insightsRes.status}`)
        throw new Error(`insights ${detail}`)
      }
      const insightsJson = (await insightsRes.json()) as {
        insights: IntelligenceInsight[]
      }
      setInsights(insightsJson.insights ?? [])

      if (healthRes.ok) {
        const hj = (await healthRes.json()) as { events_30d?: number }
        setEventsCount(typeof hj.events_30d === 'number' ? hj.events_30d : 0)
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load insights')
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [])

  async function runAnalysis() {
    setAnalyzing(true)
    try {
      await fetch('/api/intelligence/analyze', { method: 'POST' })
      await load()
    } catch (err) {
      console.warn('[intel] analyze failed', err)
    } finally {
      setAnalyzing(false)
    }
  }

  function resolve(id: string, action: 'act' | 'dismiss') {
    setRemoving((prev) => new Set(prev).add(id))
    start(async () => {
      try {
        const res = await fetch('/api/intelligence/insights', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, action }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // Wait for the leave animation, then drop from list.
        setTimeout(() => {
          setInsights((prev) => (prev ?? []).filter((i) => i.id !== id))
          setRemoving((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        }, 220)
      } catch (err) {
        console.warn('[intel] resolve failed', err)
        setRemoving((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    })
  }

  const mode: Mode = (() => {
    if (error) return 'error'
    if (insights == null) return 'loading'
    if (insights.length > 0) return 'ready'
    if (eventsCount != null && eventsCount < MIN_EVENTS_FOR_LEARNING)
      return 'learning'
    return 'empty'
  })()

  return (
    <section className="relative overflow-hidden rounded-2xl aiea-glass-strong p-6 shadow-2xl shadow-violet-500/5">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.06] via-violet-500/[0.04] to-fuchsia-500/[0.06]"
      />
      <header className="relative mb-5 flex items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/25 bg-violet-500/[0.08] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-violet-200">
            <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 animate-pulse" />
            Intelligence
          </div>
          <h2 className="mt-3 text-xl font-semibold tracking-tight aiea-gradient-text">
            What AIEA is noticing
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            Patterns learned from your activity. Tap to act, dismiss to teach
            the system.
          </p>
        </div>
        <button
          type="button"
          onClick={runAnalysis}
          disabled={analyzing}
          className="shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-violet-400/40 hover:text-white disabled:opacity-40"
        >
          {analyzing ? 'Analyzing…' : 'Refresh'}
        </button>
      </header>

      <div className="relative">
      {mode === 'loading' && <SkeletonRows />}
      {mode === 'error' && <ErrorState message={error ?? 'Unknown'} />}
      {mode === 'learning' && <LearningState eventsCount={eventsCount ?? 0} />}
      {mode === 'empty' && <EmptyState onAnalyze={runAnalysis} />}
      {mode === 'ready' && insights && (
        <ul className="space-y-3 aiea-stagger">
          {insights.map((i) => (
            <InsightCard
              key={i.id}
              insight={i}
              busy={pending}
              leaving={removing.has(i.id)}
              onAct={() => resolve(i.id, 'act')}
              onDismiss={() => resolve(i.id, 'dismiss')}
            />
          ))}
        </ul>
      )}
      </div>
    </section>
  )
}

function InsightCard({
  insight,
  busy,
  leaving,
  onAct,
  onDismiss,
}: {
  insight: IntelligenceInsight
  busy: boolean
  leaving: boolean
  onAct: () => void
  onDismiss: () => void
}) {
  const meta = insight.metadata as { confidence?: number }
  const confidence =
    typeof meta?.confidence === 'number'
      ? Math.max(0, Math.min(1, meta.confidence))
      : null

  const target = pickTarget(insight)
  const icon = pickIcon(insight.insight_type)
  const tone = pickTone(insight.priority)

  return (
    <li
      className={`group relative overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition-all duration-200 hover:border-white/[0.12] hover:bg-white/[0.035] ${
        leaving
          ? 'translate-x-2 scale-95 opacity-0'
          : 'translate-x-0 scale-100 opacity-100'
      }`}
      style={{ animation: leaving ? undefined : 'intel-in 240ms ease-out' }}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${tone.line}`}
      />
      <div className="flex items-start gap-3">
        <div
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tone.iconBg} ${tone.iconText}`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="truncate text-sm font-medium text-zinc-100">
              {insight.title}
            </h3>
            {confidence != null && (
              <ConfidencePip value={confidence} />
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-400">{insight.description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {target ? (
              <Link
                href={target.href}
                onClick={onAct}
                className="inline-flex items-center gap-1.5 rounded-lg aiea-cta px-3 py-1.5 text-xs font-medium text-white"
              >
                {target.label}
                <span aria-hidden="true">→</span>
              </Link>
            ) : (
              <button
                type="button"
                onClick={onAct}
                disabled={busy}
                className="rounded-lg aiea-cta px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Got it
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              disabled={busy}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-white/[0.18] hover:text-zinc-200 disabled:opacity-40"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes intel-in {
          0% { opacity: 0; transform: translateY(4px) scale(0.98); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </li>
  )
}

function ConfidencePip({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500 tabular-nums"
      title={`Confidence ${pct}%`}
    >
      <span className="relative inline-block h-1.5 w-10 overflow-hidden rounded-full bg-white/[0.05]">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </span>
      {pct}%
    </span>
  )
}

function SkeletonRows() {
  return (
    <ul className="space-y-3">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-4"
        >
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 shrink-0 rounded-lg aiea-shimmer" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/3 rounded aiea-shimmer" />
              <div className="h-3 w-full rounded aiea-shimmer" />
              <div className="h-3 w-1/2 rounded aiea-shimmer" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function LearningState({ eventsCount }: { eventsCount: number }) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-8 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 ring-1 ring-inset ring-white/10 text-violet-200 animate-float">
        <PulseGlyph />
      </div>
      <h3 className="mt-4 text-sm font-medium text-zinc-100">
        The system is learning…
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
        {eventsCount} signal{eventsCount === 1 ? '' : 's'} captured so far. Use
        the app for a few days and patterns will start surfacing here.
      </p>
    </div>
  )
}

function EmptyState({ onAnalyze }: { onAnalyze: () => void }) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-8 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 ring-1 ring-inset ring-white/10 text-violet-200">
        <SparkGlyph />
      </div>
      <h3 className="mt-4 text-sm font-medium text-zinc-100">
        No active insights right now
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
        That&apos;s normal — your network is in a steady state. Run analysis to
        scan for new patterns.
      </p>
      <button
        type="button"
        onClick={onAnalyze}
        className="mt-5 rounded-lg aiea-cta px-4 py-2 text-xs font-medium text-white"
      >
        Run analysis now
      </button>
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.08] p-4 text-sm text-rose-200">
      Couldn&apos;t load insights — {message}.
    </div>
  )
}

// ---------- helpers ----------

function pickTarget(
  insight: IntelligenceInsight,
): { href: string; label: string } | null {
  const meta = insight.metadata as {
    contact_id?: unknown
    contact_ids?: unknown
  }
  if (typeof meta?.contact_id === 'string') {
    return {
      href: `/contacts/${meta.contact_id}`,
      label: 'Open contact',
    }
  }
  if (
    Array.isArray(meta?.contact_ids) &&
    meta.contact_ids.length > 0 &&
    typeof meta.contact_ids[0] === 'string'
  ) {
    return {
      href: `/contacts/${meta.contact_ids[0]}`,
      label: 'Open first contact',
    }
  }
  if (insight.insight_type === 'timing_preference') {
    return null
  }
  return null
}

function pickTone(priority: number) {
  if (priority <= 1) {
    return {
      line: 'from-rose-500/40 via-fuchsia-500/40 to-violet-500/40',
      iconBg: 'bg-rose-500/15',
      iconText: 'text-rose-300',
    }
  }
  if (priority === 2) {
    return {
      line: 'from-fuchsia-500/40 via-violet-500/40 to-indigo-500/40',
      iconBg: 'bg-fuchsia-500/15',
      iconText: 'text-fuchsia-300',
    }
  }
  if (priority === 3) {
    return {
      line: 'from-violet-500/40 via-indigo-500/40 to-sky-500/40',
      iconBg: 'bg-violet-500/15',
      iconText: 'text-violet-300',
    }
  }
  return {
    line: 'from-indigo-500/40 via-sky-500/40 to-emerald-500/40',
    iconBg: 'bg-indigo-500/15',
    iconText: 'text-indigo-300',
  }
}

function pickIcon(insightType: string): React.ReactNode {
  if (insightType === 'relationship_decay') return <DecayGlyph />
  if (insightType === 'timing_preference') return <ClockGlyph />
  if (insightType === 'engagement_pattern') return <ClusterGlyph />
  if (insightType === 'commitment_pattern') return <CheckGlyph />
  return <SparkGlyph />
}

function DecayGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 17 9 11l4 4 8-8" />
      <path d="M21 7v6h-6" />
    </svg>
  )
}
function ClockGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
function ClusterGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M8 7l3 9M16 7l-3 9M7 7l10 0" />
    </svg>
  )
}
function CheckGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4 12 5 5L20 6" />
    </svg>
  )
}
function SparkGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </svg>
  )
}
function PulseGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-violet-300"
    >
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </svg>
  )
}
