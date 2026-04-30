'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../lib/supabase/client'

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
        setDescription('')
        setDueAt('')
        setContactId('')
        router.refresh()
      }
    })
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-zinc-200 bg-white p-4"
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="New commitment…"
          required
          className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
        />
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
        />
        <select
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
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
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {error && (
        <p className="mt-3 text-sm text-red-600">{error}</p>
      )}
    </form>
  )
}
