import Link from 'next/link'
import type { ReciprocityFlag } from '../lib/intelligence/reciprocity-flags'
import { Card, SectionHeader } from './cards'
import { HelpDot } from './Tooltip'

const SEVERITY_DOT: Record<ReciprocityFlag['severity'], string> = {
  critical: 'bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.6)]',
  high: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]',
  medium: 'bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.45)]',
}

export function ReciprocityFlags({ flags }: { flags: ReciprocityFlag[] }) {
  if (flags.length === 0) return null
  return (
    <section className="animate-fade-up">
      <SectionHeader
        eyebrow="Reciprocity"
        title={
          <span className="inline-flex items-center gap-2">
            Overinvesting{' '}
            <span className="text-zinc-600 font-normal">({flags.length})</span>
            <HelpDot content="Relationships where you've delivered substantially more than they have. The move is either: stop investing unilaterally, or make a specific ask so they can reciprocate cleanly." />
          </span>
        }
        subtitle="Imbalanced relationships — where the give-take has tilted too far."
      />
      <div className="grid gap-3 aiea-stagger">
        {flags.map((flag) => (
          <FlagCard key={flag.id} flag={flag} />
        ))}
      </div>
    </section>
  )
}

function FlagCard({ flag }: { flag: ReciprocityFlag }) {
  const scoreLabel = flag.reciprocity_score.toFixed(2)
  return (
    <Link href={flag.href} className="group block">
      <Card interactive>
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[flag.severity]}`}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                {flag.severity}
              </span>
              <span className="text-[10px] tabular-nums text-zinc-500">
                · score {scoreLabel}
              </span>
              {(flag.you_did > 0 || flag.they_did > 0) && (
                <span className="text-[10px] tabular-nums text-zinc-500">
                  · {flag.you_did}:{flag.they_did}
                </span>
              )}
            </div>
            <p className="text-sm text-zinc-100 group-hover:text-white">
              {flag.hint}
            </p>
          </div>
          <span className="shrink-0 self-center text-[11px] font-medium text-violet-300 transition-colors group-hover:text-violet-200">
            View →
          </span>
        </div>
      </Card>
    </Link>
  )
}
