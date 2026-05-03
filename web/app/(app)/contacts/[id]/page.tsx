import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '../../../../lib/supabase/server'
import { PageViewTracker } from '../../../../components/PageViewTracker'
import { PersonalDetailsEditor } from '../../../../components/PersonalDetailsEditor'
import { QuickAddInteraction } from '../../../../components/QuickAddInteraction'
import { InteractionTimeline } from '../../../../components/InteractionTimeline'
import { MeetingPrepBrief } from '../../../../components/MeetingPrepBrief'
import { RelationshipHealthBar } from '../../../../components/RelationshipHealth'
import { contactName, formatRelative, formatPhone } from '../../../../lib/format'
import type {
  Commitment,
  Contact,
  Interaction,
} from '../../../../lib/types'

export const dynamic = 'force-dynamic'

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: contactData }, ixRes, comRes] = await Promise.all([
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
      .order('due_at', { ascending: true, nullsFirst: false }),
  ])

  const contact = contactData as Contact | null
  if (!contact) notFound()
  const displayName = contactName(contact)

  const interactions = (ixRes.data ?? []) as Interaction[]
  const commitments = (comRes.data ?? []) as Commitment[]
  const openCommitments = commitments.filter((c) => c.status === 'open')

  const followUp = contact.next_follow_up
    ? new Date(contact.next_follow_up)
    : null
  const followUpDays = followUp
    ? Math.ceil((followUp.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
        <PageViewTracker eventType="contact_viewed" contactId={contact.id} />
        <Link
          href="/"
          className="inline-block text-sm text-zinc-500 hover:text-zinc-200"
        >
          ← Back
        </Link>

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="bg-gradient-to-r from-indigo-300 via-violet-300 to-fuchsia-300 bg-clip-text text-3xl font-medium tracking-tight text-transparent">
              {displayName}
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              {[contact.title, contact.company].filter(Boolean).join(' · ') ||
                '—'}
            </p>
          </div>
          <QuickAddInteraction
            contactId={contact.id}
            contactName={displayName}
          />
        </header>

        {followUp && (
          <div className="rounded-xl border border-violet-500/40 bg-violet-500/10 p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-violet-300">
              Next follow-up
            </div>
            <div className="mt-1 text-base text-zinc-100">
              {followUp.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
              {followUpDays != null && (
                <span className="ml-2 text-sm text-zinc-400">
                  {followUpDays === 0
                    ? '(today)'
                    : followUpDays > 0
                      ? `(in ${followUpDays}d)`
                      : `(${Math.abs(followUpDays)}d overdue)`}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-3">
          <DarkCard className="md:col-span-1">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Contact info
            </h2>
            <dl className="space-y-2 text-sm">
              <Field label="Email" value={contact.email} mono />
              <Field label="Phone" value={formatPhone(contact.phone)} mono />
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
                      className="text-violet-400 hover:underline"
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
              <Field
                label="Tier"
                value={contact.tier ? `T${contact.tier}` : null}
              />
            </dl>
          </DarkCard>

          <div className="space-y-6 md:col-span-2">
            <DarkCard>
              <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Relationship health
              </h2>
              <RelationshipHealthBar
                contact={contact}
                interactions={interactions}
                commitments={commitments}
              />
            </DarkCard>

            <MeetingPrepBrief contactId={contact.id} />
          </div>
        </div>

        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
            Personal details
          </h2>
          <DarkCard>
            <PersonalDetailsEditor
              contactId={contact.id}
              initial={contact.personal_details}
            />
          </DarkCard>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
            Open commitments{' '}
            <span className="text-zinc-600">({openCommitments.length})</span>
          </h2>
          <DarkCard>
            {openCommitments.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No open commitments for {displayName}.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {openCommitments.map((c) => {
                  const overdue =
                    c.due_at != null && new Date(c.due_at) < new Date()
                  return (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-3 py-3 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-zinc-100">
                          {c.description}
                        </div>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {c.owner === 'them' ? 'they owe' : 'you owe'}
                          {c.due_at && (
                            <span className={overdue ? ' text-red-400' : ''}>
                              {' · '}due{' '}
                              {new Date(c.due_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </DarkCard>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
            Interaction timeline{' '}
            <span className="text-zinc-600">({interactions.length})</span>
          </h2>
          <DarkCard>
            <InteractionTimeline interactions={interactions} />
          </DarkCard>
        </section>
      </div>
    </div>
  )
}

function DarkCard({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={`rounded-xl border border-zinc-800 bg-zinc-900 p-5 ${className}`}
    >
      {children}
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
        className={`min-w-0 truncate text-right text-zinc-200 ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value || <span className="text-zinc-600">—</span>}
      </dd>
    </div>
  )
}
