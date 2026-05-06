import { createClient } from '../../../lib/supabase/server'
import { AddCommitmentForm } from '../../../components/AddCommitmentForm'
import {
  CommitmentTracker,
  type EnrichedCommitment,
} from '../../../components/CommitmentTracker'
import { PageHeader } from '../../../components/cards'
import { contactName } from '../../../lib/format'
import type { Commitment, Contact } from '../../../lib/types'

export const dynamic = 'force-dynamic'

export default async function CommitmentsPage() {
  const supabase = await createClient()
  const [{ data: cData }, { data: contactsData }] = await Promise.all([
    supabase
      .from('commitments')
      .select('*')
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('contacts')
      .select('id, first_name, last_name, email')
      .order('last_name', { ascending: true })
      .order('first_name', { ascending: true }),
  ])
  const commitments = (cData ?? []) as Commitment[]
  const contacts = (contactsData ?? []) as Pick<
    Contact,
    'id' | 'first_name' | 'last_name' | 'email'
  >[]
  const contactsForForm = contacts.map((c) => ({ id: c.id, name: contactName(c) }))
  const nameById = new Map(contacts.map((c) => [c.id, contactName(c)]))

  const enriched: EnrichedCommitment[] = commitments.map((c) => ({
    ...c,
    contact_name: c.contact_id ? (nameById.get(c.contact_id) ?? null) : null,
  }))

  const open = enriched.filter((c) => c.status === 'open')
  const overdue = open.filter(
    (c) => c.due_at && new Date(c.due_at) < new Date(),
  )

  return (
    <div className="space-y-8 animate-fade-up">
      <PageHeader
        eyebrow="Loop"
        title="Commitments"
        subtitle={
          open.length === 0
            ? 'No open commitments. Clean slate.'
            : `${open.length} open${overdue.length ? ` — ${overdue.length} overdue` : ''}. Keep the loop closed.`
        }
      />

      <AddCommitmentForm contacts={contactsForForm} />

      <CommitmentTracker commitments={enriched} showFilter />
    </div>
  )
}
