import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '../../../../lib/supabase/server'
import { Card, SectionHeader } from '../../../../components/cards'
import {
  TagEditor,
  TierSelector,
} from '../../../../components/ContactEditor'
import { HealthChart } from '../../../../components/HealthChart'
import {
  formatDate,
  formatRelative,
  healthColor,
} from '../../../../lib/format'
import type {
  Commitment,
  Contact,
  Interaction,
  RelationshipSnapshot,
} from '../../../../lib/types'

export const dynamic = 'force-dynamic'

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: contactData }, interactions, commitments, snapshots] =
    await Promise.all([
      supabase.from('contacts').select('*').eq('id', id).maybeSingle(),
      supabase
        .from('interactions')
        .select('*')
        .eq('contact_id', id)
        .order('occurred_at', { ascending: false })
        .limit(50),
      supabase
        .from('commitments')
        .select('*')
        .eq('contact_id', id)
        .eq('status', 'open')
        .order('due_at', { ascending: true, nullsFirst: false }),
      supabase
        .from('relationship_snapshots')
        .select('*')
        .eq('contact_id', id)
        .order('captured_at', { ascending: true })
        .limit(50),
    ])

  const contact = contactData as Contact | null
  if (!contact) notFound()

  const ix = (interactions.data ?? []) as Interaction[]
  const cs = (commitments.data ?? []) as Commitment[]
  const snaps = (snapshots.data ?? []) as RelationshipSnapshot[]
  const latestHealth = snaps.length
    ? snaps[snaps.length - 1].health_score
    : null

  return (
    <div className="space-y-8">
      <Link
        href="/"
        className="inline-block text-sm text-zinc-500 hover:text-zinc-900"
      >
        ← Back
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">
            {contact.name}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {[contact.title, contact.company].filter(Boolean).join(' · ') ||
              '—'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-sm font-medium ${healthColor(latestHealth)}`}
          >
            {latestHealth != null
              ? `health ${(latestHealth * 100).toFixed(0)}%`
              : 'no health data'}
          </span>
        </div>
      </header>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-1">
          <h2 className="mb-3 text-sm font-medium">Contact info</h2>
          <dl className="space-y-2 text-sm">
            <Field label="Email" value={contact.email} mono />
            <Field label="Phone" value={contact.phone} mono />
            <Field label="Company" value={contact.company} />
            <Field label="Title" value={contact.title} />
            <Field
              label="LinkedIn"
              value={
                contact.linkedin ? (
                  <a
                    href={contact.linkedin}
                    target="_blank"
                    rel="noreferrer"
                    className="text-zinc-700 underline hover:text-zinc-900"
                  >
                    Profile
                  </a>
                ) : null
              }
            />
            <Field
              label="Last seen"
              value={
                contact.last_interaction_at
                  ? formatRelative(contact.last_interaction_at)
                  : null
              }
            />
          </dl>
        </Card>

        <div className="space-y-6 md:col-span-2">
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">Tier</h2>
            </div>
            <TierSelector contact={contact} />
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-medium">Tags</h2>
            <TagEditor contact={contact} />
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-medium">Relationship health</h2>
            <HealthChart snapshots={snaps} />
          </Card>
        </div>
      </div>

      <section>
        <SectionHeader
          title="Open commitments"
          subtitle={`${cs.length} open`}
        />
        <Card>
          {cs.length === 0 ? (
            <p className="text-sm text-zinc-400">
              No open commitments for this contact.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {cs.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between py-3 text-sm"
                >
                  <span>{c.description}</span>
                  <span className="text-xs text-zinc-500">
                    due {formatDate(c.due_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <SectionHeader
          title="Interaction timeline"
          subtitle={`${ix.length} interactions`}
        />
        <Card>
          {ix.length === 0 ? (
            <p className="text-sm text-zinc-400">No interactions logged.</p>
          ) : (
            <ul className="space-y-4">
              {ix.map((it) => (
                <li
                  key={it.id}
                  className="border-l-2 border-zinc-200 pl-4"
                >
                  <div className="flex items-center justify-between text-xs text-zinc-500">
                    <span>
                      {it.channel ?? 'unknown'}
                      {it.direction ? ` · ${it.direction}` : ''}
                    </span>
                    <span>{formatRelative(it.occurred_at)}</span>
                  </div>
                  {it.summary && (
                    <p className="mt-1 text-sm">{it.summary}</p>
                  )}
                  {!it.summary && it.body && (
                    <p className="mt-1 line-clamp-3 text-sm text-zinc-600">
                      {it.body}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  )
}

function Field({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-zinc-500">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value || <span className="text-zinc-400">—</span>}
      </dd>
    </div>
  )
}
