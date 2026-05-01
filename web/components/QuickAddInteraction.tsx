'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ActionItem, InteractionType } from '../lib/types'

const TYPES: InteractionType[] = ['call', 'meeting', 'email', 'text', 'in-person', 'other']

export function QuickAddInteraction({
  contactId,
  contactName,
}: {
  contactId: string
  contactName: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  const [type, setType] = useState<InteractionType>('meeting')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 16))
  const [summary, setSummary] = useState('')
  const [keyPointsText, setKeyPointsText] = useState('')
  const [actionsText, setActionsText] = useState('')
  const [followUp, setFollowUp] = useState('')

  function reset() {
    setType('meeting')
    setDate(new Date().toISOString().slice(0, 16))
    setSummary('')
    setKeyPointsText('')
    setActionsText('')
    setFollowUp('')
    setErr(null)
  }

  function parseActions(text: string): ActionItem[] {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const owner: 'me' | 'them' = /^they\s+|^they:|^t\s/i.test(line)
          ? 'them'
          : 'me'
        const desc = line.replace(/^(they|me|i)\s*[:\-]\s*/i, '')
        return { description: desc, owner, completed: false }
      })
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!summary.trim()) {
      setErr('Summary is required.')
      return
    }
    start(async () => {
      setErr(null)
      const keyPoints = keyPointsText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const actionItems = parseActions(actionsText)
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          type,
          date: new Date(date).toISOString(),
          summary: summary.trim(),
          key_points: keyPoints,
          action_items: actionItems,
          follow_up_date: followUp ? new Date(followUp).toISOString() : null,
          source: 'manual',
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setErr(data.error ?? 'Failed to save')
        return
      }
      reset()
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 px-3.5 py-2 text-sm font-medium text-white shadow-sm shadow-violet-500/20 transition-opacity hover:opacity-90"
      >
        <span className="text-base leading-none">+</span> Log interaction
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-zinc-950/80 px-4 py-12 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-full max-w-lg space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
      >
        <div>
          <h3 className="text-base font-medium text-zinc-100">
            Log interaction with {contactName}
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            Action items prefixed with “they:” go to them, otherwise to you.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
              Type
            </span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as InteractionType)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
              When
            </span>
            <input
              type="datetime-local"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            Summary
          </span>
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One-line summary"
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            Key points <span className="text-zinc-600">(one per line)</span>
          </span>
          <textarea
            rows={3}
            value={keyPointsText}
            onChange={(e) => setKeyPointsText(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            Action items{' '}
            <span className="text-zinc-600">
              (one per line — prefix “they:” for theirs)
            </span>
          </span>
          <textarea
            rows={3}
            value={actionsText}
            onChange={(e) => setActionsText(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            Follow up
          </span>
          <input
            type="date"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
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
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-violet-500/20 disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
