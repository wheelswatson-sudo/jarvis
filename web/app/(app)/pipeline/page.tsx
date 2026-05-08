import Link from 'next/link'
import { createClient } from '../../../lib/supabase/server'
import { EmptyState, PageHeader } from '../../../components/cards'
import {
  contactName,
  formatRelative,
  pipelineStageColor,
  pipelineStageDot,
  tierColor,
  tierLabel,
} from '../../../lib/format'
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  type Contact,
  type PipelineStage,
} from '../../../lib/types'

export const dynamic = 'force-dynamic'

async function loadPipeline() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('contacts')
    .select('*')
    .not('pipeline_stage', 'is', null)
    .order('pipeline_updated_at', { ascending: false, nullsFirst: false })

  const contacts = (data ?? []) as Contact[]
  const grouped = new Map<PipelineStage, Contact[]>()
  for (const stage of PIPELINE_STAGES) grouped.set(stage, [])
  for (const c of contacts) {
    if (c.pipeline_stage && grouped.has(c.pipeline_stage)) {
      grouped.get(c.pipeline_stage)!.push(c)
    }
  }
  return { grouped, total: contacts.length }
}

export default async function PipelinePage() {
  const { grouped, total } = await loadPipeline()

  return (
    <div className="space-y-8 animate-fade-up">
      <PageHeader
        eyebrow="Pipeline"
        title="Your relationship pipeline"
        subtitle={
          total === 0
            ? "Tag contacts with a stage on their profile to see them here."
            : `${total} contact${total === 1 ? '' : 's'} across ${PIPELINE_STAGES.length} stages.`
        }
      />

      {total === 0 ? (
        <EmptyState
          title="No staged contacts yet"
          body="Open any contact and pick a pipeline stage. They'll show up here, grouped by where they sit in the funnel."
          action={
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white"
            >
              Browse contacts →
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 aiea-stagger">
          {PIPELINE_STAGES.map((stage) => (
            <PipelineColumn
              key={stage}
              stage={stage}
              contacts={grouped.get(stage) ?? []}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PipelineColumn({
  stage,
  contacts,
}: {
  stage: PipelineStage
  contacts: Contact[]
}) {
  return (
    <div className="rounded-2xl aiea-glass p-3">
      <div className="mb-3 flex items-center justify-between gap-2 px-1">
        <div className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full shadow-[0_0_8px_currentColor] ${pipelineStageDot(stage)}`}
          />
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-300">
            {PIPELINE_STAGE_LABELS[stage]}
          </h2>
        </div>
        <span className="rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] tabular-nums text-zinc-400 ring-1 ring-inset ring-white/[0.06]">
          {contacts.length}
        </span>
      </div>

      {contacts.length === 0 ? (
        <p className="px-1 py-4 text-xs text-zinc-600">No one here yet.</p>
      ) : (
        <ul className="space-y-2">
          {contacts.map((c) => (
            <li key={c.id}>
              <PipelineCard contact={c} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PipelineCard({ contact }: { contact: Contact }) {
  const name = contactName(contact)
  const note = contact.pipeline_notes?.trim()
  return (
    <Link
      href={`/contacts/${contact.id}`}
      className="group block rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition-all hover:border-violet-500/30 hover:bg-white/[0.04]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-zinc-100 group-hover:text-white">
            {name}
          </div>
          {contact.company && (
            <div className="mt-0.5 truncate text-xs text-zinc-500">
              {contact.company}
            </div>
          )}
        </div>
        {contact.tier != null && (
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${tierColor(contact.tier)}`}
          >
            {tierLabel(contact.tier)}
          </span>
        )}
      </div>

      {note && (
        <p className="mt-2 line-clamp-2 text-xs text-zinc-400">{note}</p>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-600">
        <span>
          {contact.last_interaction_at
            ? `last ${formatRelative(contact.last_interaction_at)}`
            : 'no activity yet'}
        </span>
        {contact.pipeline_stage && (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[9px] ${pipelineStageColor(contact.pipeline_stage)}`}
          >
            {PIPELINE_STAGE_LABELS[contact.pipeline_stage]}
          </span>
        )}
      </div>
    </Link>
  )
}
