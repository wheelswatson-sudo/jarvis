import {
  corsError,
  corsJson,
  corsPreflight,
  getExtensionUser,
} from '../../../../../lib/extension-auth'
import { getServiceClient } from '../../../../../lib/supabase/service'
import { contactName } from '../../../../../lib/format'
import type {
  Commitment,
  Contact,
  Interaction,
} from '../../../../../lib/types'

export const dynamic = 'force-dynamic'

export function OPTIONS() {
  return corsPreflight()
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86_400_000)
}

function healthLabel(contact: Contact): string {
  const score = contact.relationship_score
  const lastDays = daysSince(contact.last_interaction_at)
  if (score != null) {
    const pct = Math.round(score * 100)
    if (pct >= 75) return `Strong (${pct}%)`
    if (pct >= 50) return `Healthy (${pct}%)`
    if (pct >= 25) return `Cooling (${pct}%)`
    return `Cold (${pct}%)`
  }
  if (lastDays == null) return 'No signal yet'
  if (lastDays > 60) return `Cold — ${lastDays}d since last contact`
  if (lastDays > 21) return `Cooling — ${lastDays}d since last contact`
  return `Healthy — ${lastDays}d since last contact`
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getExtensionUser(req)
  if (!user) return corsError(401, 'Unauthorized', 'unauthorized')
  const { id } = await params

  const svc = getServiceClient()
  if (!svc) return corsError(500, 'Service client unavailable', 'no_service')

  const { data: contactRow, error: contactErr } = await svc
    .from('contacts')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (contactErr) return corsError(500, contactErr.message, 'query_failed')
  if (!contactRow) {
    return corsError(404, 'Contact not found', 'contact_not_found')
  }
  const contact = contactRow as Contact

  const [{ data: ix }, { data: cm }] = await Promise.all([
    svc
      .from('interactions')
      .select('*')
      .eq('user_id', user.id)
      .eq('contact_id', id)
      .order('occurred_at', { ascending: false })
      .limit(1),
    svc
      .from('commitments')
      .select('*')
      .eq('user_id', user.id)
      .eq('contact_id', id)
      .eq('status', 'open')
      .order('due_at', { ascending: true, nullsFirst: false })
      .limit(8),
  ])

  const last = (ix ?? [])[0] as Interaction | undefined
  const commitments = (cm ?? []) as Commitment[]

  return corsJson({
    contact: {
      id: contact.id,
      name: contactName(contact),
      company: contact.company,
      title: contact.title,
      relationship_score: contact.relationship_score,
      next_follow_up: contact.next_follow_up,
      last_interaction_at: contact.last_interaction_at,
      tier: contact.tier,
    },
    health_label: healthLabel(contact),
    last_interaction_summary: last?.summary ?? null,
    open_commitments: commitments.map((c) => ({
      id: c.id,
      description: c.description,
      owner: c.owner,
      due_at: c.due_at,
    })),
    next_follow_up: contact.next_follow_up,
    detected_changes: [],
  })
}
