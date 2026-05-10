'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ForgottenLoop, ForgottenLoopType } from '../lib/intelligence/forgotten-loops'
import { Card, SectionHeader } from './cards'
import { HelpDot } from './Tooltip'

const TYPE_META: Record<ForgottenLoopType, { eyebrow: string; tone: string }> = {
  unreplied_inbound: {
    eyebrow: 'Inbound',
    tone: 'bg-rose-500/10 text-rose-200 ring-rose-500/30',
  },
  silent_overdue_commitment: {
    eyebrow: 'Promise',
    tone: 'bg-amber-500/10 text-amber-200 ring-amber-500/30',
  },
  stalled_outbound: {
    eyebrow: 'Stalled',
    tone: 'bg-violet-500/10 text-violet-200 ring-violet-500/30',
  },
}

const SEVERITY_DOT: Record<ForgottenLoop['severity'], string> = {
  critical: 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.6)]',
  high: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]',
  medium: 'bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.45)]',
}

// Loops anchored to a message can be drafted automatically. Commitments
// can't — those need the user to actually deliver the thing.
function isDraftable(loop: ForgottenLoop): boolean {
  return (
    (loop.type === 'unreplied_inbound' || loop.type === 'stalled_outbound') &&
    loop.message_id != null
  )
}

export function ForgottenLoops({ loops }: { loops: ForgottenLoop[] }) {
  if (loops.length === 0) return null
  return (
    <section className="animate-fade-up">
      <SectionHeader
        eyebrow="Forgotten loops"
        title={
          <span className="inline-flex items-center gap-2">
            What fell through the cracks{' '}
            <span className="text-zinc-600 font-normal">({loops.length})</span>
            <HelpDot content="Threads with no reply, promises past due, conversations that died mid-flight. A great EA catches these before you do." />
          </span>
        }
        subtitle="Synthesized from inbox, commitments, and last-touch timestamps."
      />
      <div className="grid gap-3 aiea-stagger">
        {loops.map((loop) => (
          <LoopCard key={loop.id} loop={loop} />
        ))}
      </div>
    </section>
  )
}

function LoopCard({ loop }: { loop: ForgottenLoop }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [, startTransition] = useTransition()

  const draftable = isDraftable(loop)

  async function handleDraft() {
    if (!loop.message_id || generating) return
    setError(null)
    setGenerating(true)
    try {
      const res = await fetch('/api/drafts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_id: loop.message_id,
          contact_id: loop.contact_id,
          trigger: 'forgotten_loop',
        }),
      })
      const json = (await res.json()) as { draft_id?: string; error?: string }
      if (!res.ok || !json.draft_id) {
        throw new Error(json.error ?? 'Draft generation failed')
      }
      startTransition(() => {
        router.push(`/drafts?id=${json.draft_id}`)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Draft generation failed')
      setGenerating(false)
    }
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[loop.severity]}`}
        />
        <Link
          href={loop.href}
          className="group min-w-0 flex-1 space-y-1"
          aria-label={`Open ${loop.contact_name}`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${TYPE_META[loop.type].tone}`}
            >
              {TYPE_META[loop.type].eyebrow}
            </span>
            <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
              {loop.severity}
            </span>
            <span className="text-[10px] tabular-nums text-zinc-500">
              · {loop.days}d
            </span>
          </div>
          <p className="text-sm text-zinc-100 group-hover:text-white">
            {loop.hint}
          </p>
          {loop.snippet && (
            <p className="line-clamp-1 text-xs text-zinc-500">
              “{loop.snippet}”
            </p>
          )}
          {error && (
            <p className="pt-1 text-[11px] text-rose-300">{error}</p>
          )}
        </Link>
        <div className="flex shrink-0 items-center gap-2 self-center">
          {draftable ? (
            <button
              type="button"
              onClick={handleDraft}
              disabled={generating}
              className="inline-flex items-center gap-1 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-[11px] font-medium text-violet-200 transition-colors hover:border-violet-400/60 hover:bg-violet-500/20 hover:text-violet-100 disabled:cursor-progress disabled:opacity-60"
            >
              {generating ? (
                <>
                  <Spinner /> Drafting…
                </>
              ) : (
                <>Draft reply →</>
              )}
            </button>
          ) : (
            <Link
              href={loop.href}
              className="text-[11px] font-medium text-violet-300 transition-colors hover:text-violet-200"
            >
              {loop.cta} →
            </Link>
          )}
        </div>
      </div>
    </Card>
  )
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border border-violet-300/30 border-t-violet-200"
    />
  )
}
