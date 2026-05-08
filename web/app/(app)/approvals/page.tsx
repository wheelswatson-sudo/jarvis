import { createClient } from '../../../lib/supabase/server'
import { PendingChangesQueue } from '../../../components/PendingChangesQueue'
import { EmptyState, PageHeader } from '../../../components/cards'
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
    <div className="space-y-8 animate-fade-up">
      <PageHeader
        eyebrow="Sync guard"
        title="Approval queue"
        subtitle="When Google or Apollo wants to overwrite a field you edited, the change waits here. Approve or reject — your edits are never silently overwritten."
      />

      {groups.length === 0 ? (
        <EmptyState
          icon={
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m4 12 5 5L20 6" />
            </svg>
          }
          title="Nothing pending"
          body="Your contact data is in sync. Conflicting auto-sync changes will show up here for you to review."
        />
      ) : (
        <PendingChangesQueue groups={groups} />
      )}
    </div>
  )
}
