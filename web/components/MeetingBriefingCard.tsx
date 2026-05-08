'use client'

import Link from 'next/link'
import { useState } from 'react'
import { tierColor, tierLabel, formatRelative } from '../lib/format'
import { PIPELINE_STAGE_LABELS } from '../lib/types'
import type {
  Briefing,
  MatchedAttendee,
  UnmatchedAttendee,
} from '../lib/contacts/meeting-briefings'

const HEALTH_TONE: Record<MatchedAttendee['health'], string> = {
  strong: 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30',
  steady: 'text-zinc-300 bg-white/[0.04] ring-white/10',
  cooling: 'text-amber-300 bg-amber-500/10 ring-amber-500/30',
  cold: 'text-rose-300 bg-rose-500/10 ring-rose-500/30',
  unknown: 'text-zinc-500 bg-white/[0.02] ring-white/[0.05]',
}

const TREND_TONE: Record<NonNullable<MatchedAttendee['trend']>, string> = {
  warming: 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30',
  stable: 'text-zinc-300 bg-white/[0.04] ring-white/10',
  cooling: 'text-amber-300 bg-amber-500/10 ring-amber-500/30',
  dormant: 'text-rose-300 bg-rose-500/10 ring-rose-500/30',
}

export function MeetingBriefingCard({
  briefing,
  variant = 'list',
}: {
  briefing: Briefing
  variant?: 'list' | 'detail'
}) {
  const isDetail = variant === 'detail'
  const matched = briefing.attendees.filter(
    (a): a is MatchedAttendee => a.kind === 'matched',
  )
  const unmatched = briefing.attendees.filter(
    (a): a is UnmatchedAttendee => a.kind === 'unmatched',
  )

  return (
    <article className="relative overflow-hidden rounded-2xl aiea-glass p-5">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-indigo-500/15 via-violet-500/10 to-fuchsia-500/15 opacity-60 blur-2xl"
      />

      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-medium text-zinc-100 sm:text-lg">
            {isDetail ? (
              briefing.title || 'Untitled meeting'
            ) : (
              <Link
                href={`/briefings/${briefing.event_id}`}
                className="transition-colors hover:text-violet-200"
              >
                {briefing.title || 'Untitled meeting'}
              </Link>
            )}
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            {formatMeetingTime(briefing.start_at, briefing.end_at)}
            {briefing.location ? ` · ${briefing.location}` : ''}
          </p>
        </div>
        {briefing.conference_url && (
          <a
            href={briefing.conference_url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-md border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-medium text-violet-200 transition-colors hover:border-violet-400/60 hover:bg-violet-500/20"
          >
            Join →
          </a>
        )}
      </div>

      {briefing.talking_points.length > 0 && (
        <div className="relative mt-4 rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-3">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-violet-300">
            Things to remember
          </div>
          <ul className="space-y-1 text-sm text-zinc-200">
            {briefing.talking_points.map((p, i) => (
              <li key={i} className="leading-snug">
                <span className="mr-1.5 text-violet-400">→</span>
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      {briefing.attendees.length === 0 ? (
        <p className="relative mt-4 text-xs text-zinc-500">
          No attendees on this event.
        </p>
      ) : (
        <div className="relative mt-4 space-y-2">
          {matched.map((a) => (
            <MatchedAttendeeRow key={a.contact_id} a={a} variant={variant} />
          ))}
          {unmatched.map((a) => (
            <UnmatchedAttendeeRow key={a.email} a={a} />
          ))}
        </div>
      )}

      {!isDetail && briefing.attendees.length > 0 && (
        <div className="relative mt-4 flex justify-end">
          <Link
            href={`/briefings/${briefing.event_id}`}
            className="text-xs text-violet-300 transition-colors hover:text-violet-200"
          >
            Full briefing →
          </Link>
        </div>
      )}

      {isDetail && briefing.description && (
        <details className="relative mt-4 rounded-xl border border-white/[0.05] bg-white/[0.02] p-3">
          <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-400">
            Event description
          </summary>
          <div className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">
            {briefing.description}
          </div>
        </details>
      )}
    </article>
  )
}

function MatchedAttendeeRow({
  a,
  variant,
}: {
  a: MatchedAttendee
  variant: 'list' | 'detail'
}) {
  const isDetail = variant === 'detail'
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/contacts/${a.contact_id}`}
          className="min-w-0 truncate text-sm font-medium text-zinc-100 transition-colors hover:text-violet-200"
        >
          {a.name}
        </Link>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {a.tier != null && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide ${tierColor(a.tier)}`}
            >
              {tierLabel(a.tier)}
            </span>
          )}
          {a.pipeline_stage && (
            <span className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[10px] font-medium text-zinc-300">
              {PIPELINE_STAGE_LABELS[a.pipeline_stage]}
            </span>
          )}
          {a.trend && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${TREND_TONE[a.trend]}`}
            >
              {a.trend}
            </span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${HEALTH_TONE[a.health]}`}
          >
            {a.health === 'unknown' ? 'no signal' : a.health}
          </span>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
        <span>
          last contact{' '}
          <span className="text-zinc-400">
            {formatRelative(a.last_interaction_at)}
          </span>
        </span>
        {a.half_life_days != null && a.half_life_days > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span>half-life {a.half_life_days.toFixed(0)}d</span>
          </>
        )}
        {a.open_commitments.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-amber-300">
              {a.open_commitments.length} open commitment
              {a.open_commitments.length === 1 ? '' : 's'}
            </span>
          </>
        )}
      </div>

      {isDetail && a.pipeline_notes && (
        <div className="mt-2 rounded-lg border border-white/[0.05] bg-white/[0.02] p-2 text-xs leading-relaxed text-zinc-300">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
            Pipeline notes
          </div>
          {a.pipeline_notes}
        </div>
      )}

      {isDetail && a.open_commitments.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
            Open commitments
          </div>
          <ul className="space-y-0.5 text-xs">
            {a.open_commitments.map((c) => {
              const tag = c.owner === 'me' ? 'You owe' : 'They owe'
              return (
                <li key={c.id} className="text-zinc-300">
                  <span className="text-zinc-500">·</span> [{tag}] {c.description}
                  {c.due_at && (
                    <span className="text-zinc-500">
                      {' '}
                      (due {c.due_at.slice(0, 10)})
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {isDetail && a.recent_messages.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
            Recent messages
          </div>
          <ul className="space-y-1 text-xs">
            {a.recent_messages.map((m) => (
              <li
                key={m.id}
                className="rounded-md border border-white/[0.04] bg-white/[0.015] p-2"
              >
                <div className="flex items-baseline justify-between gap-2 text-[10px] text-zinc-500">
                  <span className="uppercase tracking-wide">
                    {m.channel} · {m.direction}
                  </span>
                  <span className="tabular-nums">
                    {formatRelative(m.sent_at)}
                  </span>
                </div>
                {m.subject && (
                  <div className="mt-0.5 truncate font-medium text-zinc-200">
                    {m.subject}
                  </div>
                )}
                {m.snippet && (
                  <p className="mt-0.5 line-clamp-2 leading-relaxed text-zinc-400">
                    {m.snippet}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function UnmatchedAttendeeRow({ a }: { a: UnmatchedAttendee }) {
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    setBusy(true)
    setError(null)
    try {
      const [first, ...rest] = (a.name ?? '').trim().split(/\s+/)
      const res = await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contacts: [
            {
              first_name: first || null,
              last_name: rest.join(' ') || null,
              email: a.email,
            },
          ],
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? `HTTP ${res.status}`)
        setBusy(false)
        return
      }
      setAdded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-zinc-300">
            {a.name || a.email}
          </div>
          {a.name && (
            <div className="truncate font-mono text-[11px] text-zinc-500">
              {a.email}
            </div>
          )}
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-500">
            Not in contacts
          </div>
        </div>
        {added ? (
          <span className="shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
            Added ✓
          </span>
        ) : (
          <button
            type="button"
            onClick={add}
            disabled={busy}
            className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:border-violet-400/40 hover:text-white disabled:opacity-50"
          >
            {busy ? 'Adding…' : '+ Add to contacts'}
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2 text-[11px] text-rose-300">Failed: {error}</p>
      )}
    </div>
  )
}

export function formatMeetingTime(
  startIso: string,
  endIso: string | null,
): string {
  const start = new Date(startIso)
  if (Number.isNaN(start.getTime())) return '—'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const after = new Date(tomorrow)
  after.setDate(after.getDate() + 1)

  const startTime = start.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  const endTime = endIso
    ? new Date(endIso).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      })
    : null
  const range = endTime ? `${startTime}–${endTime}` : startTime

  if (start >= today && start < tomorrow) return `Today, ${range}`
  if (start >= tomorrow && start < after) return `Tomorrow, ${range}`
  return `${start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })}, ${range}`
}
