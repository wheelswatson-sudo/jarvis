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
          className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
            t === tier
              ? tierColor(t)
              : 'bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 ring-1 ring-inset ring-white/[0.06]'
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
          <span className="text-sm text-zinc-500">No tags.</span>
        )}
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-200 ring-1 ring-inset ring-white/[0.08]"
          >
            {t}
            <button
              type="button"
              onClick={() => remove(t)}
              disabled={pending}
              className="text-zinc-500 transition-colors hover:text-rose-300"
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
          className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
        />
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          className="rounded-lg aiea-cta px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </div>
  )
}
