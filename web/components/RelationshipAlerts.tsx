import Link from 'next/link'
import { contactName } from '../lib/format'
import type { Commitment, Contact, Interaction } from '../lib/types'

type Alert = {
  id: string
  tone: 'red' | 'amber' | 'violet' | 'fuchsia'
  title: string
  detail: string
  href?: string
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000))
}

export function buildAlerts(
  contacts: Contact[],
  commitments: Commitment[],
  interactions: Pick<Interaction, 'contact_id' | 'summary' | 'occurred_at'>[],
): Alert[] {
  const alerts: Alert[] = []
  const now = Date.now()

  const lastInteractionByContact = new Map<
    string,
    { summary: string | null; occurred_at: string }
  >()
  for (const ix of interactions) {
    if (!ix.contact_id) continue
    const cur = lastInteractionByContact.get(ix.contact_id)
    if (!cur || new Date(ix.occurred_at) > new Date(cur.occurred_at)) {
      lastInteractionByContact.set(ix.contact_id, {
        summary: ix.summary,
        occurred_at: ix.occurred_at,
      })
    }
  }

  for (const c of contacts) {
    if (c.tier !== 1 && c.tier !== 2) continue
    const days = daysSince(c.last_interaction_at)
    if (days == null) continue
    const threshold = c.tier === 1 ? 21 : 45
    if (days > threshold) {
      const last = lastInteractionByContact.get(c.id)
      const topic = last?.summary
        ? ` — last discussed ${truncate(last.summary, 60)}`
        : ''
      alerts.push({
        id: `decay-${c.id}`,
        tone: c.tier === 1 ? 'red' : 'amber',
        title: `Haven't spoken to ${contactName(c)} in ${days}d`,
        detail: `T${c.tier}${topic}`,
        href: `/contacts/${c.id}`,
      })
    }
  }

  const overdueByContact = new Map<string, Commitment[]>()
  for (const com of commitments) {
    if (com.status !== 'open' || !com.due_at || !com.contact_id) continue
    if (new Date(com.due_at).getTime() >= now) continue
    const list = overdueByContact.get(com.contact_id) ?? []
    list.push(com)
    overdueByContact.set(com.contact_id, list)
  }
  for (const [contactId, list] of overdueByContact) {
    const contact = contacts.find((c) => c.id === contactId)
    if (!contact) continue
    if (list.length >= 2) {
      alerts.push({
        id: `overdue-${contactId}`,
        tone: 'fuchsia',
        title: `${list.length} overdue commitments with ${contactName(contact)}`,
        detail: list
          .slice(0, 2)
          .map((c) => truncate(c.description, 50))
          .join(' · '),
        href: `/contacts/${contactId}`,
      })
    }
  }

  for (const c of contacts) {
    if (!c.next_follow_up) continue
    const dueIn = Math.floor(
      (new Date(c.next_follow_up).getTime() - now) / (24 * 60 * 60 * 1000),
    )
    if (dueIn < -1 || dueIn > 1) continue
    alerts.push({
      id: `follow-${c.id}`,
      tone: 'violet',
      title: `Follow up with ${contactName(c)}${dueIn < 0 ? ' (overdue)' : dueIn === 0 ? ' today' : ' tomorrow'}`,
      detail: 'You scheduled this from a previous interaction.',
      href: `/contacts/${c.id}`,
    })
  }

  alerts.sort((a, b) => toneRank(a.tone) - toneRank(b.tone))
  return alerts.slice(0, 8)
}

function toneRank(t: Alert['tone']): number {
  return { red: 0, fuchsia: 1, amber: 2, violet: 3 }[t]
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const TONE_BORDER: Record<Alert['tone'], string> = {
  red: 'border-rose-500/30 hover:border-rose-400/60',
  fuchsia: 'border-fuchsia-500/30 hover:border-fuchsia-400/60',
  amber: 'border-amber-500/30 hover:border-amber-400/60',
  violet: 'border-violet-500/30 hover:border-violet-400/60',
}
const TONE_DOT: Record<Alert['tone'], string> = {
  red: 'bg-rose-400 shadow-rose-500/50',
  fuchsia: 'bg-fuchsia-400 shadow-fuchsia-500/50',
  amber: 'bg-amber-400 shadow-amber-500/50',
  violet: 'bg-violet-400 shadow-violet-500/50',
}

export function RelationshipAlerts({
  contacts,
  commitments,
  interactions,
}: {
  contacts: Contact[]
  commitments: Commitment[]
  interactions: Pick<Interaction, 'contact_id' | 'summary' | 'occurred_at'>[]
}) {
  const alerts = buildAlerts(contacts, commitments, interactions)
  if (alerts.length === 0) {
    return (
      <div className="rounded-2xl aiea-glass p-5 text-sm text-zinc-500">
        Nothing decaying. Network is in steady state.
      </div>
    )
  }
  return (
    <div className="space-y-2 aiea-stagger">
      {alerts.map((a) => {
        const inner = (
          <div
            className={`flex items-start gap-3 rounded-xl border bg-white/[0.02] p-3 transition-colors ${TONE_BORDER[a.tone]}`}
          >
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full shadow-[0_0_8px_currentColor] ${TONE_DOT[a.tone]}`}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-zinc-100">
                {a.title}
              </div>
              <div className="mt-0.5 truncate text-xs text-zinc-400">
                {a.detail}
              </div>
            </div>
          </div>
        )
        return a.href ? (
          <Link key={a.id} href={a.href}>
            {inner}
          </Link>
        ) : (
          <div key={a.id}>{inner}</div>
        )
      })}
    </div>
  )
}
