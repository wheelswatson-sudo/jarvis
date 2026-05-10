import Link from 'next/link'
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
          <Link key={loop.id} href={loop.href} className="group block">
            <Card interactive>
              <div className="flex items-start gap-4">
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[loop.severity]}`}
                />
                <div className="min-w-0 flex-1 space-y-1">
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
                </div>
                <span className="shrink-0 self-center text-[11px] font-medium text-violet-300 transition-colors group-hover:text-violet-200">
                  {loop.cta} →
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  )
}
