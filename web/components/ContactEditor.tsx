'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../lib/supabase/client'
import { trackEventClient } from '../lib/events-client'
import { tierColor } from '../lib/format'
import { TIER_GLOSSARY } from '../lib/glossary'
import { Tooltip, HelpDot } from './Tooltip'
import { useToast } from './Toast'
import type { Contact } from '../lib/types'

export function TierSelector({ contact }: { contact: Contact }) {
  const router = useRouter()
  const toast = useToast()
  const [tier, setTier] = useState<number | null>(contact.tier)
  const [pending, start] = useTransition()

  function update(next: number) {
    const prev = tier
    setTier(next)
    start(async () => {
      const supabase = createClient()
      const { error } = await supabase
        .from('contacts')
        .update({ tier: next })
        .eq('id', contact.id)
      if (error) {
        setTier(prev)
        toast.error(`Couldn't update tier — ${error.message}`)
        return
      }
      trackEventClient({
        eventType: 'contact_updated',
        contactId: contact.id,
        metadata: { field: 'tier', from: contact.tier, to: next },
      })
      const label =
        TIER_GLOSSARY[`T${next}` as 'T1' | 'T2' | 'T3'].label
      toast.success(`Set to Tier ${next} (${label})`)
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3].map((t) => {
        const meta = TIER_GLOSSARY[`T${t}` as 'T1' | 'T2' | 'T3']
        return (
          <Tooltip
            key={t}
            content={
              <span>
                <span className="font-medium text-zinc-100">
                  Tier {t} · {meta.label}
                </span>
                <br />
                {meta.description}
              </span>
            }
          >
            <button
              type="button"
              onClick={() => update(t)}
              disabled={pending}
              aria-label={`Set tier ${t} — ${meta.label}`}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-all disabled:opacity-50 ${
                t === tier
                  ? tierColor(t)
                  : 'bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 ring-1 ring-inset ring-white/[0.06]'
              }`}
            >
              T{t}
            </button>
          </Tooltip>
        )
      })}
      <span className="ml-1">
        <HelpDot
          content={
            <span>
              <span className="font-medium text-zinc-100">Tiers</span>
              <br />
              T1 = inner circle (closest 5-15).
              <br />
              T2 = important advisors and partners.
              <br />
              T3 = quarterly check-ins.
              <br />
              Higher tier = AIEA nudges harder when they cool down.
            </span>
          }
        />
      </span>
    </div>
  )
}

export function TagEditor({ contact }: { contact: Contact }) {
  const router = useRouter()
  const toast = useToast()
  const [tags, setTags] = useState<string[]>(contact.tags ?? [])
  const [draft, setDraft] = useState('')
  const [pending, start] = useTransition()

  function persist(next: string[], action: 'added' | 'removed', tag: string) {
    const prev = contact.tags ?? []
    start(async () => {
      const supabase = createClient()
      const { error } = await supabase
        .from('contacts')
        .update({ tags: next })
        .eq('id', contact.id)
      if (error) {
        setTags(prev)
        toast.error(`Couldn't update tags — ${error.message}`)
        return
      }
      trackEventClient({
        eventType: 'contact_updated',
        contactId: contact.id,
        metadata: { field: 'tags', count: next.length },
      })
      toast.success(`Tag ${action}: ${tag}`)
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
    persist(next, 'added', v)
  }

  function remove(t: string) {
    const next = tags.filter((x) => x !== t)
    setTags(next)
    persist(next, 'removed', t)
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 && (
          <span className="text-sm text-zinc-500">
            No tags yet. Try <em className="text-zinc-400 not-italic">investor</em>,{' '}
            <em className="text-zinc-400 not-italic">customer</em>, or{' '}
            <em className="text-zinc-400 not-italic">family</em> to filter
            quickly.
          </span>
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
