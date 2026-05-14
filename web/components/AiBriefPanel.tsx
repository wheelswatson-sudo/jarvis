// AiBriefPanel — "The read"
// Editorial-style executive briefing panel. Renders the LLM-generated
// AiBriefNarrative as a story arc: lede (context + why_now) → action
// (open_with) → marginalia (watch) → signature (goal). Volume modulates
// down the page; a single warm amber accent marks the actionable beat
// inside the otherwise-violet AIEA palette.
//
// Drop-in for the existing MeetingBriefingCard (compact) and the
// /briefings/[id] detail page (detail). Server-component safe.

import type { ReactNode } from 'react'
import type { AiBriefNarrative } from '../lib/contacts/meeting-briefings'

const STALE_AFTER_HOURS = 24

export function AiBriefPanel({
  narrative,
  variant = 'detail',
  meetingTitle,
}: {
  narrative: AiBriefNarrative | null
  variant?: 'compact' | 'detail'
  meetingTitle?: string
}) {
  if (!narrative) {
    return <BriefDrafting variant={variant} />
  }

  const isCompact = variant === 'compact'
  const stale = isStale(narrative.computed_at)
  const ariaLabel = meetingTitle
    ? `Pre-meeting brief for ${meetingTitle}`
    : 'Pre-meeting brief'

  return (
    <article
      aria-label={ariaLabel}
      className="relative isolate overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.035] via-white/[0.015] to-white/[0.04]"
    >
      {/* Paper grain — adds material feel. Hand-rolled SVG so the panel
          stays self-contained (no asset pipeline coupling). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180' viewBox='0 0 180 180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.5 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />

      {/* The arc rule — the story axis. Violet at top, amber at bottom;
          each section's eyebrow number is tinted to where it sits on it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 h-full w-px bg-gradient-to-b from-violet-500/0 via-violet-400/40 to-amber-400/30"
      />

      {/* Soft violet glow, top-right — atmospheric, not chrome. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-violet-500/[0.08] blur-3xl"
      />

      <div className={`relative ${isCompact ? 'p-5' : 'p-6 sm:p-8'}`}>
        <header className="mb-5 flex items-baseline justify-between gap-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-violet-200/80">
            The read
          </p>
          {(narrative.computed_at || narrative.model) && (
            <p className="font-mono text-[10px] tabular-nums text-zinc-600">
              {narrative.computed_at && (
                <span className={stale ? 'text-amber-400/80' : ''}>
                  {formatComputedAt(narrative.computed_at)}
                  {stale ? ' · stale' : ''}
                </span>
              )}
              {narrative.model && narrative.computed_at && (
                <span aria-hidden="true" className="px-1.5 text-zinc-700">
                  ·
                </span>
              )}
              {narrative.model && (
                <span>{narrative.model.replace(/^claude-/, '')}</span>
              )}
            </p>
          )}
        </header>

        {/* 01 — Lede. context + why_now read as one breath. */}
        <Section num="01" tone="lede" delayMs={isCompact ? 0 : 60}>
          <div className="space-y-2">
            {narrative.context && (
              <p
                className={`font-serif italic leading-[1.55] tracking-[-0.005em] text-zinc-300 ${
                  isCompact
                    ? 'line-clamp-2 text-[14.5px]'
                    : 'text-[16.5px] sm:text-[17.5px]'
                }`}
                style={textWrapPretty}
              >
                {narrative.context}
              </p>
            )}
            {narrative.why_now && !isCompact && (
              <p
                className="font-serif text-[16.5px] font-medium italic leading-[1.55] tracking-[-0.005em] text-zinc-100 sm:text-[17.5px]"
                style={textWrapPretty}
              >
                {narrative.why_now}
              </p>
            )}
          </div>
        </Section>

        {/* 02 — Open with. The action beat. Warm accent breaks the violet
            field; the dot on the rule is the visual hinge of the panel. */}
        {narrative.open_with && (
          <Section
            num="02"
            tone="action"
            label="Open with"
            delayMs={isCompact ? 60 : 160}
          >
            <blockquote className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[26px] top-0 bottom-0 w-px bg-gradient-to-b from-amber-400/40 via-amber-400/80 to-amber-400/30"
              />
              <span
                aria-hidden="true"
                className="absolute -left-[29px] top-2 h-[7px] w-[7px] rounded-full bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.55)]"
              />
              <p
                className={`font-serif leading-[1.5] text-zinc-50 ${
                  isCompact ? 'text-[14.5px]' : 'text-[16px] sm:text-[16.5px]'
                }`}
                style={textWrapBalance}
              >
                {narrative.open_with}
              </p>
            </blockquote>
          </Section>
        )}

        {/* 03 — Watch. Marginalia. Detail variant only. */}
        {!isCompact && narrative.watch.length > 0 && (
          <Section num="03" tone="watch" label="Watch" delayMs={240}>
            <ul
              aria-label="Things to listen for during this meeting"
              className="space-y-1.5"
            >
              {narrative.watch.map((w, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 text-[13px] leading-[1.55] text-zinc-400"
                >
                  <span
                    aria-hidden="true"
                    className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-rose-300/70"
                  />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Compact tease — link out to the full read. */}
        {isCompact && (
          <p className="mt-5 pl-[26px] text-[11px] text-zinc-500">
            <span className="text-violet-300/90">
              Watch list, goal, and full attendee context
            </span>
            <span className="text-zinc-600"> — </span>
            <span className="text-violet-300">read full brief →</span>
          </p>
        )}

        {/* Goal — the signature. Quietest beat. Tapered rule mirrors
            the left axis to close the composition. */}
        {!isCompact && narrative.goal && (
          <footer className="mt-7">
            <div
              aria-hidden="true"
              className="ml-[26px] mb-3 h-px w-2/3 bg-gradient-to-r from-violet-500/30 via-white/[0.06] to-transparent"
            />
            <div className="flex items-baseline gap-3 pl-[26px]">
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                Goal
              </p>
              <p
                className="text-[12.5px] italic leading-relaxed text-zinc-500"
                style={textWrapPretty}
              >
                {narrative.goal}
              </p>
            </div>
          </footer>
        )}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Section — chapter-numbered block. Each section gets a tinted "01" / "02"
// / "03" eyebrow positioned so the digits line up vertically across the panel
// (the 26px left padding on content keeps the eyebrows in their own column).
// ---------------------------------------------------------------------------

type SectionTone = 'lede' | 'action' | 'watch'

const NUM_TINT: Record<SectionTone, string> = {
  lede: 'text-violet-300/45',
  action: 'text-amber-300/60',
  watch: 'text-rose-300/45',
}
const LABEL_TINT: Record<SectionTone, string> = {
  lede: 'text-violet-200/70',
  action: 'text-amber-200/85',
  watch: 'text-rose-200/70',
}

function Section({
  num,
  label,
  tone,
  delayMs,
  children,
}: {
  num: string
  label?: string
  tone: SectionTone
  delayMs?: number
  children: ReactNode
}) {
  const animStyle =
    delayMs && delayMs > 0
      ? { animationDelay: `${delayMs}ms`, animationFillMode: 'both' as const }
      : undefined
  return (
    <section
      className={`relative animate-fade-up ${num !== '01' ? 'mt-6' : ''}`}
      style={animStyle}
    >
      <header className="mb-2 flex items-baseline gap-3">
        <span
          aria-hidden="true"
          className={`font-mono text-[10px] tabular-nums ${NUM_TINT[tone]}`}
        >
          {num}
        </span>
        {label && (
          <span
            className={`font-mono text-[10px] uppercase tracking-[0.28em] ${LABEL_TINT[tone]}`}
          >
            {label}
          </span>
        )}
      </header>
      <div className="pl-[26px]">{children}</div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Drafting state — when the meeting has matched contacts but the brief
// hasn't generated yet. Atmospheric, not a spinner.
// ---------------------------------------------------------------------------

function BriefDrafting({ variant }: { variant: 'compact' | 'detail' }) {
  const isCompact = variant === 'compact'
  return (
    <article
      aria-label="Brief drafting"
      aria-busy="true"
      className="relative isolate overflow-hidden rounded-2xl border border-white/[0.05] bg-white/[0.015]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 h-full w-px bg-gradient-to-b from-violet-500/0 via-violet-500/25 to-amber-400/15"
      />
      <div className={`relative ${isCompact ? 'p-5' : 'p-6 sm:p-8'}`}>
        <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-violet-300/60">
          The read
        </p>
        <p
          className={`mt-4 font-serif italic text-zinc-500/80 ${
            isCompact ? 'text-[14px]' : 'text-[16px]'
          }`}
        >
          Reading the room…
        </p>
        <div className="mt-3 h-px w-32 overflow-hidden rounded-full bg-white/[0.04]">
          <div className="h-full w-1/3 animate-pulse bg-gradient-to-r from-violet-500/60 via-violet-300/70 to-amber-400/60" />
        </div>
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const textWrapPretty: React.CSSProperties = {
  textWrap: 'pretty' as React.CSSProperties['textWrap'],
}
const textWrapBalance: React.CSSProperties = {
  textWrap: 'balance' as React.CSSProperties['textWrap'],
}

function formatComputedAt(iso: string): string {
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return ''
  const mins = Math.round((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function isStale(iso?: string): boolean {
  if (!iso) return false
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return false
  return Date.now() - ts > STALE_AFTER_HOURS * 60 * 60 * 1000
}
