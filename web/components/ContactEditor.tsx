'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../lib/supabase/client'
import { trackEventClient } from '../lib/events-client'
import { tierColor } from '../lib/format'
import type { Contact } from '../lib/types'

export function TierSelector({ contact }: { contact: Contact }) {
  const router = useRouter()
  const [tier, setTier] = useState<number | null>(contact.tier)
  const [pending, start] = useTransition()

  function update(next: number) {
    setTier(next)
    start(async () => {
      const supabase = createClient()
      await supabase
        .from('contacts')
        .update({ tier: next })
        .eq('id', contact.id)
      trackEventClient({
        eventType: 'contact_updated',
        contactId: contact.id,
        metadata: { field: 'tier', from: contact.tier, to: next },
      })
      router.refresh()
    })
  }

  return (
    <div className="flex gap-1">
      {[1, 2, 3].map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => update(t)}
          disabled={pending}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            t === tier
              ? tierColor(t)
              : 'bg-zinc-50 text-zinc-500 hover:bg-zinc-100'
          }`}
        >
          T{t}
        </button>
      ))}
    </div>
  )
}

export function TagEditor({ contact }: { contact: Contact }) {
  const router = useRouter()
  const [tags, setTags] = useState<string[]>(contact.tags ?? [])
  const [draft, setDraft] = useState('')
  const [pending, start] = useTransition()

  function persist(next: string[]) {
    start(async () => {
      const supabase = createClient()
      await supabase.from('contacts').update({ tags: next }).eq('id', contact.id)
      trackEventClient({
        eventType: 'contact_updated',
        contactId: contact.id,
        metadata: { field: 'tags', count: next.length },
      })
      router.refresh()
    })
  }

  function add(e: React.FormEvent) {
    e.preventDefault()
    const v = draft.trim()
    if (!v || tags.includes(v)) return
    const next = [...tags, v]
    setTags(next)
    setDraft('')
    persist(next)
  }

  function remove(t: string) {
    const next = tags.filter((x) => x !== t)
    setTags(next)
    persist(next)
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 && (
          <span className="text-sm text-zinc-400">No tags.</span>
        )}
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700"
          >
            {t}
            <button
              type="button"
              onClick={() => remove(t)}
              disabled={pending}
              className="text-zinc-400 hover:text-zinc-700"
              aria-label={`Remove ${t}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <form onSubmit={add} className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add tag…"
          className="flex-1 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-zinc-400"
        />
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </div>
  )
}
