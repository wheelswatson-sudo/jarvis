'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../lib/supabase/client'
import { trackEventClient } from '../lib/events-client'
import { useToast } from './Toast'

type Owner = 'me' | 'them'

// Default a new commitment to one week out — the most common case is
// "follow up by next week" and an empty date field hides the action behind
// extra clicks. Saturday → Friday is intentional, not a weekend.
function defaultDueDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  return d.toISOString().slice(0, 10)
}

export function AddCommitmentForm({
  contacts,
}: {
  contacts: { id: string; name: string }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [description, setDescription] = useState('')
  const [dueAt, setDueAt] = useState(defaultDueDate())
  const [contactId, setContactId] = useState('')
  const [owner, setOwner] = useState<Owner>('me')
  const [pending, start] = useTransition()
  const [createAnother, setCreateAnother] = useState(false)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const desc = description.trim()
    if (!desc) return
    start(async () => {
      const supabase = createClient()
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) {
        toast.error('Not signed in.')
        return
      }
      const { error } = await supabase.from('commitments').insert({
        user_id: userData.user.id,
        description: desc,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        contact_id: contactId || null,
        owner,
        // commitments.direction is NOT NULL with a 'me' default. Mirror it
        // with owner so "they owe me X" rows aren't silently filed under
        // direction='me'. Same pattern as POST /api/commitments.
        direction: owner,
        status: 'open',
      })
      if (error) {
        toast.error(`Couldn't save — ${error.message}`)
        return
      }
      trackEventClient({
        eventType: 'commitment_created',
        contactId: contactId || null,
        metadata: { description: desc, has_due_date: !!dueAt, owner },
      })
      const who = contactId
        ? contacts.find((c) => c.id === contactId)?.name
        : null
      toast.success(
        who ? `Tracked: ${desc} · with ${who}` : `Tracked: ${desc}`,
      )
      setDescription('')
      setDueAt(defaultDueDate())
      if (!createAnother) {
        setContactId('')
        setOwner('me')
      }
      router.refresh()
    })
  }

  return (
    <form onSubmit={submit} className="rounded-2xl aiea-glass p-4 space-y-3">
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What did you commit to? (e.g. send Sarah the deck)"
        required
        autoComplete="off"
        className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
      />
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">
            Due date
          </span>
          <input
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">
            Contact <span className="text-zinc-600">(optional)</span>
          </span>
          <select
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
          >
            <option value="">— No contact —</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">
            Direction
          </span>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-1 text-xs">
            <button
              type="button"
              onClick={() => setOwner('me')}
              className={`rounded-md px-2 py-1.5 transition-all ${owner === 'me' ? 'bg-indigo-500/20 text-indigo-200 ring-1 ring-inset ring-indigo-500/30' : 'text-zinc-400 hover:text-zinc-100'}`}
            >
              You owe
            </button>
            <button
              type="button"
              onClick={() => setOwner('them')}
              className={`rounded-md px-2 py-1.5 transition-all ${owner === 'them' ? 'bg-fuchsia-500/20 text-fuchsia-200 ring-1 ring-inset ring-fuchsia-500/30' : 'text-zinc-400 hover:text-zinc-100'}`}
            >
              They owe
            </button>
          </div>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={pending || !description.trim()}
          className="rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Add commitment'}
        </button>
        <label className="inline-flex items-center gap-2 text-xs text-zinc-500 cursor-pointer">
          <input
            type="checkbox"
            checked={createAnother}
            onChange={(e) => setCreateAnother(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-white/20 bg-white/[0.04] text-violet-500 focus:ring-violet-500"
          />
          Add another after save
        </label>
      </div>
    </form>
  )
}
