import { createClient } from '../../../lib/supabase/server'
import { PendingChangesQueue } from '../../../components/PendingChangesQueue'
import { contactName } from '../../../lib/format'
import type { Contact, PendingChange } from '../../../lib/types'

type ContactNameRow = Pick<Contact, 'id' | 'first_name' | 'last_name' | 'email'>

export const dynamic = 'force-dynamic'

export default async function ApprovalsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: changesData } = user
    ? await supabase
        .from('pending_changes')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
    : { data: [] }

  const changes = (changesData ?? []) as PendingChange[]
  const contactIds = Array.from(new Set(changes.map((c) => c.contact_id)))

  let contactById = new Map<string, ContactNameRow>()
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, email')
      .in('id', contactIds)
    contactById = new Map(
      ((contacts ?? []) as ContactNameRow[]).map((c) => [c.id, c]),
    )
  }

  const groupMap = new Map<
    string,
    {
      contactId: string
      contactName: string
      changes: (PendingChange & { contact_name: string | null })[]
    }
  >()
  for (const c of changes) {
    const row = contactById.get(c.contact_id)
    const name = row ? contactName(row) : 'Unknown contact'
    const enriched = { ...c, contact_name: name }
    const existing = groupMap.get(c.contact_id)
    if (existing) {
      existing.changes.push(enriched)
    } else {
      groupMap.set(c.contact_id, {
        contactId: c.contact_id,
        contactName: name,
        changes: [enriched],
      })
    }
  }

  const groups = Array.from(groupMap.values()).sort((a, b) =>
    a.contactName.localeCompare(b.contactName),
  )

  return (
    <div className="-mx-4 -my-8 min-h-[calc(100vh-3.5rem)] bg-zinc-950 px-4 py-10 sm:-mx-6 sm:px-6">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-medium text-violet-300">
            <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400" />
            Relationship Intelligence
          </div>
          <h1 className="mt-3 bg-gradient-to-r from-indigo-200 via-violet-200 to-fuchsia-200 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
            Approval queue
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Sync sources can&apos;t silently overwrite your edits. Review each
            field change and decide what gets through.
          </p>
        </header>

        {groups.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center backdrop-blur">
            <div className="mx-auto h-10 w-10 rounded-full bg-gradient-to-br from-indigo-500/20 via-violet-500/20 to-fuchsia-500/20" />
            <h2 className="mt-4 text-base font-medium text-zinc-100">
              Nothing pending
            </h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-400">
              Your contact data is in sync. Conflicting auto-sync changes will
              show up here for you to review.
            </p>
          </div>
        ) : (
          <PendingChangesQueue groups={groups} />
        )}
      </div>
    </div>
  )
}
