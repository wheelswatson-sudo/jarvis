'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Contact, Draft } from '../lib/types'
import { Card, SectionHeader } from './cards'
import { contactName } from '../lib/format'

const PERSIST_DELAY_MS = 600

export function DraftReview({
  draft,
  contact,
}: {
  draft: Draft
  contact: Contact | null
}) {
  const router = useRouter()
  const [body, setBody] = useState(draft.body)
  const [subject, setSubject] = useState(draft.subject ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<'send' | 'discard' | null>(null)

  // Debounced autosave: every keystroke kicks a timer; previous timer cleared.
  // We keep this lightweight on purpose — saving on blur misses unsaved edits
  // when the user clicks Discard or copies straight to Gmail.
  function scheduleSave(next: { body?: string; subject?: string | null }) {
    setSaveError(null)
    setSaving(true)
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/drafts/${draft.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        })
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(json.error ?? 'Save failed')
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Save failed')
      } finally {
        setSaving(false)
      }
    }, PERSIST_DELAY_MS)
    return () => window.clearTimeout(handle)
  }

  function onBodyChange(value: string) {
    setBody(value)
    scheduleSave({ body: value })
  }

  function onSubjectChange(value: string) {
    setSubject(value)
    scheduleSave({ subject: value })
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(body)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setSaveError('Clipboard unavailable in this browser.')
    }
  }

  function openInGmail() {
    if (!contact?.email) return
    const params = new URLSearchParams()
    params.set('view', 'cm')
    params.set('fs', '1')
    params.set('to', contact.email)
    if (subject) params.set('su', subject)
    params.set('body', body)
    const url = `https://mail.google.com/mail/?${params.toString()}`
    window.open(url, '_blank', 'noopener')
  }

  async function markStatus(status: 'sent' | 'discarded') {
    setBusy(status === 'sent' ? 'send' : 'discard')
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error('Status update failed')
      router.refresh()
      router.replace('/drafts')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Update failed')
      setBusy(null)
    }
  }

  const recipientLine = contact
    ? `${contactName(contact)}${contact.email ? ` · ${contact.email}` : ''}`
    : 'Unknown recipient'

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Reviewing"
        title={recipientLine}
        subtitle={
          draft.reasoning
            ? `Reasoning: ${draft.reasoning}`
            : `Generated ${formatTimeAgo(draft.generated_at)}${draft.model ? ` via ${draft.model}` : ''}.`
        }
      />

      <Card>
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
            Subject
          </span>
          <input
            type="text"
            value={subject}
            onChange={(e) => onSubjectChange(e.target.value)}
            placeholder="(continuing thread — leave blank)"
            className="mt-2 block w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/50 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
          />
        </label>

        <label className="mt-4 block">
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
            Body
          </span>
          <textarea
            value={body}
            onChange={(e) => onBodyChange(e.target.value)}
            rows={14}
            spellCheck
            className="mt-2 block w-full resize-y rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 font-sans text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/50 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
          />
        </label>

        <div className="mt-3 flex items-center justify-between text-[11px]">
          <span className="text-zinc-500">
            {saving ? 'Saving…' : saveError ? saveError : 'Auto-saved'}
          </span>
          <span className="tabular-nums text-zinc-600">
            {body.length} chars
          </span>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={copyToClipboard}
          className="inline-flex items-center gap-2 rounded-xl border border-white/[0.1] bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-100 transition-colors hover:border-white/[0.2] hover:bg-white/[0.07]"
        >
          {copied ? 'Copied ✓' : 'Copy to clipboard'}
        </button>
        <button
          type="button"
          onClick={openInGmail}
          disabled={!contact?.email}
          className="inline-flex items-center gap-2 rounded-xl aiea-cta px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          title={contact?.email ? `Open in Gmail compose to ${contact.email}` : 'No recipient email on file'}
        >
          Open in Gmail →
        </button>
        <span className="grow" />
        <button
          type="button"
          onClick={() => markStatus('sent')}
          disabled={busy != null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:border-emerald-400/60 hover:bg-emerald-500/20 disabled:opacity-60"
        >
          {busy === 'send' ? 'Marking…' : 'Mark as sent'}
        </button>
        <button
          type="button"
          onClick={() => markStatus('discarded')}
          disabled={busy != null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-3 py-1.5 text-xs font-medium text-rose-200 transition-colors hover:border-rose-400/60 hover:bg-rose-500/20 disabled:opacity-60"
        >
          {busy === 'discard' ? 'Discarding…' : 'Discard'}
        </button>
      </div>

      {contact && (
        <div className="text-xs text-zinc-500">
          ↗ <Link href={`/contacts/${contact.id}`} className="text-violet-300 hover:text-violet-200 hover:underline">
            View {contactName(contact)}'s thread history
          </Link>
        </div>
      )}
    </div>
  )
}

function formatTimeAgo(iso: string): string {
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return 'recently'
  const mins = Math.round((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}
