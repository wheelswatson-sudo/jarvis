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
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-900 to-violet-950/30 p-5 shadow-lg shadow-violet-900/10">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="bg-gradient-to-r from-indigo-300 via-violet-300 to-fuchsia-300 bg-clip-text text-sm font-medium uppercase tracking-wide text-transparent">
            Meeting prep brief
          </h3>
          {generatedAt && (
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Generated {new Date(generatedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-200 transition hover:border-violet-500 hover:text-white disabled:opacity-50"
        >
          {loading ? 'Generating…' : 'Regenerate'}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-400">Brief failed: {error}</p>
      )}

      {loading && !brief && (
        <div className="space-y-2">
          <div className="h-3 w-1/3 animate-pulse rounded bg-zinc-800" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-800" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-800" />
        </div>
      )}

      {brief && (
        <div className="space-y-4 text-sm text-zinc-200">
          <Section title="Who they are">
            <p>{brief.who_they_are}</p>
          </Section>
          <Section title="Recent context">
            <p className="text-zinc-300">{brief.recent_context}</p>
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
                    · {it}
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
                  → {t}
                </li>
              ))}
            </ul>
          </Expandable>
          <Section title="Relationship health">
            <p className="text-zinc-300">{brief.relationship_health}</p>
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
      <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
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
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-[11px] font-medium uppercase tracking-wide text-zinc-400 hover:text-zinc-200"
      >
        <span>{title}</span>
        <span className="text-zinc-500">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}
