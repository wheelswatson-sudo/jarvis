// Dev-only preview for the ReciprocityFlags surface.
import { notFound } from 'next/navigation'
import { ReciprocityFlags } from '../../../components/ReciprocityFlags'
import type { ReciprocityFlag } from '../../../lib/intelligence/reciprocity-flags'

const FLAGS: ReciprocityFlag[] = [
  {
    id: 'reciprocity:c1',
    contact_id: 'c1',
    contact_name: 'Mark Jensen',
    reciprocity_score: -0.92,
    you_did: 8,
    they_did: 1,
    severity: 'critical',
    hint: "Mark Jensen — you're overinvesting; you've delivered 8, they've delivered 1.",
    href: '/contacts/c1',
    relationship_score: 0.58,
  },
  {
    id: 'reciprocity:c2',
    contact_id: 'c2',
    contact_name: 'Sarah Chen',
    reciprocity_score: -0.71,
    you_did: 5,
    they_did: 1,
    severity: 'high',
    hint: "Sarah Chen — you're overinvesting; you've delivered 5, they've delivered 1.",
    href: '/contacts/c2',
    relationship_score: 0.62,
  },
  {
    id: 'reciprocity:c3',
    contact_id: 'c3',
    contact_name: 'Devon Park',
    reciprocity_score: -0.56,
    you_did: 3,
    they_did: 1,
    severity: 'medium',
    hint: "Devon Park — you're overinvesting; you've delivered 3, they've delivered 1.",
    href: '/contacts/c3',
    relationship_score: 0.41,
  },
]

export default function ReciprocityPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Reciprocity flags
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Three fixtures: critical / high / medium imbalance.
          </p>
        </header>
        <ReciprocityFlags flags={FLAGS} />
      </div>
    </main>
  )
}
