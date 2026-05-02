import { createClient } from '../../../lib/supabase/server'
import { AddCommitmentForm } from '../../../components/AddCommitmentForm'
import {
  CommitmentTracker,
  type EnrichedCommitment,
} from '../../../components/CommitmentTracker'
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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
        <header>
          <h1 className="bg-gradient-to-r from-indigo-300 via-violet-300 to-fuchsia-300 bg-clip-text text-3xl font-medium tracking-tight text-transparent">
            Commitments
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Promises you&apos;ve made. Keep the loop closed.
          </p>
        </header>

        <AddCommitmentForm contacts={contactsForForm} />

        <CommitmentTracker commitments={enriched} showFilter />
      </div>
    </div>
  )
}
