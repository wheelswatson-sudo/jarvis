import { createClient } from '../../../lib/supabase/server'
import { Card } from '../../../components/cards'
import { ApprovalCard } from '../../../components/ApprovalCard'
import type { Approval, Contact } from '../../../lib/types'

export const dynamic = 'force-dynamic'

export default async function ApprovalsPage() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('approvals')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  const approvals = (data ?? []) as Approval[]
  const contactIds = Array.from(
    new Set(approvals.map((a) => a.contact_id).filter((x): x is string => !!x)),
  )

  let nameById = new Map<string, string>()
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, name')
      .in('id', contactIds)
    nameById = new Map(
      ((contacts ?? []) as Pick<Contact, 'id' | 'name'>[]).map((c) => [
        c.id,
        c.name,
      ]),
    )
  }

  const enriched = approvals.map((a) => ({
    ...a,
    contact_name: a.contact_id ? (nameById.get(a.contact_id) ?? null) : null,
  }))

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight">Approval queue</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Messages Jarvis drafted, waiting on your call.
        </p>
      </header>

      {enriched.length === 0 ? (
        <Card>
          <p className="text-sm text-zinc-400">
            Inbox zero. No drafts pending approval.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {enriched.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      )}
    </div>
  )
}
