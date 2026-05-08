import Link from 'next/link'
import { createClient } from '../../../lib/supabase/server'
import { ContactsGrid } from '../../../components/ContactsGrid'
import { EmptyState, PageHeader } from '../../../components/cards'
import { APOLLO_PROVIDER } from '../../../lib/apollo'
import type { Commitment, Contact } from '../../../lib/types'

export const dynamic = 'force-dynamic'

type ContactWithStats = Contact & { open_commitments: number }

export default async function ContactsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [contactsRes, commitmentsRes, apolloRes] = await Promise.all([
    supabase
      .from('contacts')
      .select('*')
      .order('ltv_estimate', { ascending: false, nullsFirst: false })
      .limit(500),
    supabase
      .from('commitments')
      .select('id, contact_id, status'),
    user
      ? supabase
          .from('user_integrations')
          .select('access_token')
          .eq('user_id', user.id)
          .eq('provider', APOLLO_PROVIDER)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const contacts = (contactsRes.data ?? []) as Contact[]
  const commitments = (commitmentsRes.data ?? []) as Pick<
    Commitment,
    'id' | 'contact_id' | 'status'
  >[]

  const openByContact = new Map<string, number>()
  for (const c of commitments) {
    if (c.status !== 'open' || !c.contact_id) continue
    openByContact.set(c.contact_id, (openByContact.get(c.contact_id) ?? 0) + 1)
  }

  const enriched: ContactWithStats[] = contacts.map((c) => ({
    ...c,
    open_commitments: openByContact.get(c.id) ?? 0,
  }))

  const apolloConnected =
    typeof (apolloRes.data as { access_token?: unknown } | null)?.access_token ===
      'string' &&
    ((apolloRes.data as { access_token: string }).access_token.length ?? 0) > 0

  return (
    <div className="space-y-8 animate-fade-up">
      <PageHeader
        eyebrow="People"
        title="Contacts"
        subtitle={
          enriched.length === 0
            ? 'No contacts yet — import a CSV or connect Google to seed your network.'
            : `${enriched.length} contact${enriched.length === 1 ? '' : 's'} in your network.`
        }
        action={
          <Link
            href="/contacts/import"
            className="inline-flex items-center gap-1.5 rounded-xl aiea-cta px-4 py-2 text-sm font-medium text-white"
          >
            <span aria-hidden="true">＋</span> Import contacts
          </Link>
        }
      />

      {enriched.length === 0 ? (
        <EmptyState
          title="No contacts yet"
          body="Import a CSV to seed your network, or connect Google in Settings to sync automatically."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Link
                href="/contacts/import"
                className="inline-flex items-center gap-1.5 rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white"
              >
                Import your first contacts →
              </Link>
              <Link
                href="/settings"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
              >
                Open settings
              </Link>
            </div>
          }
        />
      ) : (
        <ContactsGrid contacts={enriched} apolloConnected={apolloConnected} />
      )}
    </div>
  )
}
