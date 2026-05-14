'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../lib/supabase/client'
import { contactName } from '../lib/format'
import type { Contact, OutboundAction } from '../lib/types'

type ContactPick = Pick<
  Contact,
  'id' | 'first_name' | 'last_name' | 'email' | 'company' | 'title'
>

// Two-step modal:
//   step='pick'   — choose the target contact + write a reason
//   step='draft'  — review the generated draft, edit, mark sent, or copy
// Splitting the steps keeps the form simple (one decision per screen) and
// gives the user a clear undo path before the outbound row is created.
type Step = 'pick' | 'draft'

export function IntroduceTo({
  sourceContact,
}: {
  sourceContact: Contact
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('pick')
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  const [candidates, setCandidates] = useState<ContactPick[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  const [intro, setIntro] = useState<OutboundAction | null>(null)
  const [draftBody, setDraftBody] = useState('')
  const [draftSubject, setDraftSubject] = useState('')

  // Esc-to-close + body scroll lock — same pattern as QuickAddInteraction
  // so the modal feels native to this page.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open])

  // Lazy-load contacts the first time the modal opens. Keeps the page
  // load cheap when the user never clicks "Introduce to…".
  useEffect(() => {
    if (!open || loaded) return
    let cancelled = false
    void (async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from('contacts')
        .select('id, first_name, last_name, email, company, title')
        .neq('id', sourceContact.id)
        .order('first_name', { ascending: true })
        .limit(500)
      if (cancelled) return
      setCandidates((data ?? []) as ContactPick[])
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [open, loaded, sourceContact.id])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates.slice(0, 25)
    const out: ContactPick[] = []
    for (const c of candidates) {
      const hay = [
        c.first_name,
        c.last_name,
        c.email,
        c.company,
        c.title,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (hay.includes(q)) out.push(c)
      if (out.length >= 25) break
    }
    return out
  }, [query, candidates])

  function reset() {
    setStep('pick')
    setQuery('')
    setTargetId(null)
    setReason('')
    setIntro(null)
    setDraftBody('')
    setDraftSubject('')
    setErr(null)
  }

  function submitPick(e: React.FormEvent) {
    e.preventDefault()
    if (!targetId) {
      setErr('Pick a contact to introduce.')
      return
    }
    start(async () => {
      setErr(null)
      const res = await fetch('/api/intros', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_contact_id: sourceContact.id,
          target_contact_id: targetId,
          reason: reason.trim() || null,
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setErr(data.error ?? 'Failed to create draft')
        return
      }
      const data = (await res.json()) as { intro: OutboundAction }
      setIntro(data.intro)
      setDraftBody(data.intro.draft)
      setDraftSubject(data.intro.subject ?? '')
      setStep('draft')
    })
  }

  function saveDraft() {
    if (!intro) return
    start(async () => {
      setErr(null)
      const res = await fetch('/api/intros', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: intro.id,
          subject: draftSubject,
          draft: draftBody,
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setErr(data.error ?? 'Failed to save')
        return
      }
    })
  }

  function markSent() {
    if (!intro) return
    start(async () => {
      setErr(null)
      // Save first so the body the user just edited is what gets recorded
      // as "sent" — without this, edits between create and mark-sent are
      // silently discarded.
      await fetch('/api/intros', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: intro.id,
          subject: draftSubject,
          draft: draftBody,
        }),
      })
      const res = await fetch(`/api/intros/${intro.id}/sent`, { method: 'POST' })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setErr(data.error ?? 'Failed to mark sent')
        return
      }
      reset()
      setOpen(false)
      router.refresh()
    })
  }

  async function copyDraft() {
    const text = `Subject: ${draftSubject}\n\n${draftBody}`
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard write can fail in HTTP / restricted contexts. The user
      // can still select-all in the textarea — no user-facing error.
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-200 transition-colors hover:border-violet-400/60 hover:bg-violet-500/20 hover:text-violet-100"
      >
        <span aria-hidden="true">↔</span> Introduce to…
      </button>
    )
  }

  const sourceLabel = contactName(sourceContact)

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-[#07070b]/80 px-4 py-12 backdrop-blur-md animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`Introduce ${sourceLabel} to another contact`}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          reset()
          setOpen(false)
        }
      }}
    >
      <div className="relative w-full max-w-xl space-y-4 rounded-2xl aiea-glass-strong p-6 shadow-2xl shadow-violet-500/10 animate-fade-up">
        <button
          type="button"
          onClick={() => {
            reset()
            setOpen(false)
          }}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12" />
            <path d="M6 18L18 6" />
          </svg>
        </button>

        {step === 'pick' && (
          <form onSubmit={submitPick} className="space-y-4">
            <div>
              <h3 className="text-base font-medium text-zinc-100">
                Introduce {sourceLabel} to…
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Pick a contact and we&apos;ll draft a double-opt-in intro email.
                Nothing sends until you say so.
              </p>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Search contacts
              </span>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name, email, company…"
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
              />
            </label>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-white/[0.06]">
              {!loaded ? (
                <p className="px-3 py-4 text-xs text-zinc-500">Loading contacts…</p>
              ) : filtered.length === 0 ? (
                <p className="px-3 py-4 text-xs text-zinc-500">
                  No matches. Try a different search.
                </p>
              ) : (
                <ul className="divide-y divide-white/[0.04]">
                  {filtered.map((c) => {
                    const selected = c.id === targetId
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setTargetId(c.id)}
                          className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                            selected
                              ? 'bg-violet-500/15 text-zinc-100'
                              : 'text-zinc-200 hover:bg-white/[0.03]'
                          }`}
                        >
                          <span className="truncate font-medium">
                            {contactName(c)}
                          </span>
                          <span className="truncate text-xs text-zinc-500">
                            {[c.title, c.company].filter(Boolean).join(' · ') ||
                              c.email ||
                              ''}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Why now? <span className="text-zinc-600">(optional)</span>
              </span>
              <textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. they're both working on cold-chain logistics"
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
              />
            </label>

            {err && <p className="text-sm text-red-400">{err}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  reset()
                  setOpen(false)
                }}
                className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/[0.18]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending || !targetId}
                className="rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {pending ? 'Drafting…' : 'Draft intro'}
              </button>
            </div>
          </form>
        )}

        {step === 'draft' && intro && (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-medium text-zinc-100">
                Review the draft
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Edit if you want. Copy or mark sent — we&apos;ll auto-create a
                follow-up to check whether this led anywhere.
              </p>
            </div>

            {intro.recipient && (
              <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-zinc-400">
                <span className="text-zinc-500">To: </span>
                <span className="font-mono text-zinc-200">{intro.recipient}</span>
              </div>
            )}

            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Subject
              </span>
              <input
                type="text"
                value={draftSubject}
                onChange={(e) => setDraftSubject(e.target.value)}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Body
              </span>
              <textarea
                rows={12}
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 font-mono text-xs leading-relaxed text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
              />
            </label>

            {err && <p className="text-sm text-red-400">{err}</p>}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStep('pick')}
                className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/[0.18]"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={copyDraft}
                disabled={pending}
                className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/[0.18] disabled:opacity-50"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={saveDraft}
                disabled={pending}
                className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-white/[0.18] disabled:opacity-50"
              >
                {pending ? 'Saving…' : 'Save draft'}
              </button>
              <button
                type="button"
                onClick={markSent}
                disabled={pending}
                className="rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {pending ? 'Working…' : 'Mark sent'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
