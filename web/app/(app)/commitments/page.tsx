import { createClient } from '../../../lib/supabase/server'
import { Card, SectionHeader } from '../../../components/cards'
import { CommitmentRow } from '../../../components/CommitmentRow'
import { AddCommitmentForm } from '../../../components/AddCommitmentForm'
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
      .select('id, name')
      .order('name', { ascending: true }),
  ])
  const commitments = (cData ?? []) as Commitment[]
  const contacts = (contactsData ?? []) as Pick<Contact, 'id' | 'name'>[]
  const nameById = new Map(contacts.map((c) => [c.id, c.name]))

  const enriched = commitments.map((c) => ({
    ...c,
    contact_name: c.contact_id ? (nameById.get(c.contact_id) ?? null) : null,
  }))

  const now = new Date()
  const startOfTomorrow = new Date(now)
  startOfTomorrow.setHours(24, 0, 0, 0)

  const overdue = enriched.filter(
    (c) =>
      c.status === 'open' &&
      c.due_at != null &&
      new Date(c.due_at) < now,
  )
  const dueToday = enriched.filter(
    (c) =>
      c.status === 'open' &&
      c.due_at != null &&
      new Date(c.due_at) >= now &&
      new Date(c.due_at) < startOfTomorrow,
  )
  const upcoming = enriched.filter(
    (c) =>
      c.status === 'open' &&
      (c.due_at == null || new Date(c.due_at) >= startOfTomorrow),
  )
  const completed = enriched.filter((c) => c.status !== 'open')

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-medium tracking-tight">Commitments</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Promises you&apos;ve made. Keep the loop closed.
        </p>
      </header>

      <AddCommitmentForm contacts={contacts} />

      <Group title="Overdue" tone="red" items={overdue} />
      <Group title="Due today" tone="amber" items={dueToday} />
      <Group title="Upcoming" tone="zinc" items={upcoming} />
      <Group title="Completed" tone="zinc" items={completed} />
    </div>
  )
}

function Group({
  title,
  tone,
  items,
}: {
  title: string
  tone: 'red' | 'amber' | 'zinc'
  items: (Commitment & { contact_name: string | null })[]
}) {
  const dot =
    tone === 'red'
      ? 'bg-red-500'
      : tone === 'amber'
        ? 'bg-amber-500'
        : 'bg-zinc-300'
  return (
    <section>
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${dot}`} />
            {title}
            <span className="text-zinc-400">({items.length})</span>
          </span>
        }
      />
      <Card>
        {items.length === 0 ? (
          <p className="text-sm text-zinc-400">Nothing here.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {items.map((c) => (
              <CommitmentRow key={c.id} commitment={c} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  )
}
