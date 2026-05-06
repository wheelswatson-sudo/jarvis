'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../lib/supabase/client'
import { trackEventClient } from '../lib/events-client'

export function AddCommitmentForm({
  contacts,
}: {
  contacts: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [description, setDescription] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [contactId, setContactId] = useState('')
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const desc = description.trim()
    if (!desc) return
    start(async () => {
      setError(null)
      const supabase = createClient()
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) {
        setError('Not signed in.')
        return
      }
      const { error } = await supabase.from('commitments').insert({
        user_id: userData.user.id,
        description: desc,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        contact_id: contactId || null,
        status: 'open',
      })
      if (error) {
        setError(error.message)
      } else {
        trackEventClient({
          eventType: 'commitment_created',
          contactId: contactId || null,
          metadata: {
            description: desc,
            has_due_date: !!dueAt,
          },
        })
        setDescription('')
        setDueAt('')
        setContactId('')
        router.refresh()
      }
    })
  }

  return (
    <form onSubmit={submit} className="rounded-2xl aiea-glass p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="New commitment…"
          required
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
        />
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
        />
        <select
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
        >
          <option value="">No contact</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending || !description.trim()}
          className="rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
    </form>
  )
}
