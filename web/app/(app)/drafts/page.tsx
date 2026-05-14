import Link from 'next/link'
import { createClient } from '../../../lib/supabase/server'
import { Card, EmptyState, PageHeader, SectionHeader } from '../../../components/cards'
import { contactName, formatRelative } from '../../../lib/format'
import type { Contact, Draft } from '../../../lib/types'
import { DraftReview } from '../../../components/DraftReview'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{ id?: string }>

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const { id: focusedId } = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return (
      <div className="space-y-6 animate-fade-up">
        <PageHeader eyebrow="Drafts" title="Sign in" subtitle="Drafts are owner-only." />
      </div>
    )
  }

  const { data: drafts } = await supabase
    .from('drafts')
    .select('*')
    .eq('user_id', user.id)
    .in('status', ['pending', 'approved'])
    .order('generated_at', { ascending: false })
    .limit(50)

  const list = (drafts ?? []) as Draft[]

  // Pull contact metadata in one shot.
  const contactIds = Array.from(
    new Set(list.map((d) => d.contact_id).filter(Boolean) as string[]),
  )
  const { data: contactRows } =
    contactIds.length > 0
      ? await supabase
          .from('contacts')
          .select(
            'id, first_name, last_name, email, company, title, tier, relationship_score',
          )
          .in('id', contactIds)
      : { data: [] }
  const contactsById = new Map<string, Contact>(
    ((contactRows ?? []) as Contact[]).map((c) => [c.id, c]),
  )

  const focused = focusedId ? list.find((d) => d.id === focusedId) ?? null : list[0] ?? null

  if (list.length === 0) {
    return (
      <div className="space-y-8 animate-fade-up">
        <PageHeader
          eyebrow="Drafts"
          title="Pre-drafted replies"
          subtitle="Generated drafts queue here for your review and edit before you send."
        />
        <EmptyState
          title="No drafts pending"
          body="Drafts appear here after you click 'Draft reply' on a forgotten loop or trigger one from a contact's page."
        />
      </div>
    )
  }

  return (
    <div className="space-y-8 animate-fade-up">
      <PageHeader
        eyebrow="Drafts"
        title="Pre-drafted replies"
        subtitle={`${list.length} draft${list.length === 1 ? '' : 's'} pending review.`}
      />

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-2">
          <SectionHeader eyebrow="Queue" title="" subtitle={null} />
          <div className="space-y-2">
            {list.map((d) => {
              const contact = d.contact_id ? contactsById.get(d.contact_id) : null
              const name = contact ? contactName(contact) : 'Unknown contact'
              const isActive = focused?.id === d.id
              return (
                <Link
                  key={d.id}
                  href={`/drafts?id=${d.id}`}
                  className={`block rounded-xl border p-3 transition-colors ${
                    isActive
                      ? 'border-violet-500/50 bg-violet-500/5'
                      : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12]'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-zinc-100">
                      {name}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
                      {formatRelative(d.generated_at)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">
                    {d.subject ?? d.body.slice(0, 120)}
                  </p>
                </Link>
              )
            })}
          </div>
        </aside>

        {focused && (
          <DraftReview
            draft={focused}
            contact={focused.contact_id ? (contactsById.get(focused.contact_id) ?? null) : null}
          />
        )}
      </div>
    </div>
  )
}
