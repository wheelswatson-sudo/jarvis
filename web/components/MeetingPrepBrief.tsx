'use client'

import { useEffect, useState } from 'react'
import type { MeetingBrief } from '../lib/types'

export function MeetingPrepBrief({ contactId }: { contactId: string }) {
  const [brief, setBrief] = useState<MeetingBrief | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [openOpenItems, setOpenOpenItems] = useState(true)
  const [openTalking, setOpenTalking] = useState(true)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/brief`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? `HTTP ${res.status}`)
        setLoading(false)
        return
      }
      const data = (await res.json()) as {
        brief: MeetingBrief
        generated_at: string
      }
      setBrief(data.brief)
      setGeneratedAt(data.generated_at)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId])

  return (
    <div className="relative overflow-hidden rounded-2xl aiea-glass p-5">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.05] via-violet-500/[0.03] to-fuchsia-500/[0.05]"
      />
      <div className="relative mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[10px] font-medium uppercase tracking-[0.16em] aiea-gradient-text-vivid">
            Meeting prep brief
          </h3>
          {generatedAt && (
            <p className="mt-1 text-[11px] text-zinc-500 tabular-nums">
              Generated{' '}
              {new Date(generatedAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </p>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-violet-400/40 hover:text-white disabled:opacity-50"
        >
          {loading ? 'Generating…' : 'Regenerate'}
        </button>
      </div>

      {error && (
        <p className="relative text-sm text-rose-300">Brief failed: {error}</p>
      )}

      {loading && !brief && (
        <div className="relative space-y-2">
          <div className="h-3 w-1/3 rounded aiea-shimmer" />
          <div className="h-3 w-2/3 rounded aiea-shimmer" />
          <div className="h-3 w-1/2 rounded aiea-shimmer" />
        </div>
      )}

      {brief && (
        <div className="relative space-y-4 text-sm text-zinc-200">
          <Section title="Who they are">
            <p className="leading-relaxed">{brief.who_they_are}</p>
          </Section>
          <Section title="Recent context">
            <p className="leading-relaxed text-zinc-300">{brief.recent_context}</p>
          </Section>
          <Expandable
            title={`Open items (${brief.open_items.length})`}
            open={openOpenItems}
            onToggle={() => setOpenOpenItems((v) => !v)}
          >
            {brief.open_items.length === 0 ? (
              <p className="text-zinc-500">Nothing open. Clean slate.</p>
            ) : (
              <ul className="space-y-1">
                {brief.open_items.map((it, i) => (
                  <li key={i} className="text-zinc-300">
                    <span className="text-zinc-600">·</span> {it}
                  </li>
                ))}
              </ul>
            )}
          </Expandable>
          <Expandable
            title="Suggested talking points"
            open={openTalking}
            onToggle={() => setOpenTalking((v) => !v)}
          >
            <ul className="space-y-1">
              {brief.suggested_talking_points.map((t, i) => (
                <li key={i} className="text-zinc-200">
                  <span className="text-violet-400">→</span> {t}
                </li>
              ))}
            </ul>
          </Expandable>
          <Section title="Relationship health">
            <p className="leading-relaxed text-zinc-300">{brief.relationship_health}</p>
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h4 className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
        {title}
      </h4>
      {children}
    </div>
  )
}

function Expandable({
  title,
  open,
  onToggle,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-3 transition-colors hover:border-white/[0.10]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-400 transition-colors hover:text-zinc-200"
      >
        <span>{title}</span>
        <span className="text-zinc-500 text-base leading-none">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  )
}
