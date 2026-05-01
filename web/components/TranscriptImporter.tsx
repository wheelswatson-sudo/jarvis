'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ActionItem } from '../lib/types'

type Preview = {
  source: string
  participants: string[]
  date: string | null
  key_points: string[]
  action_items: ActionItem[]
  decisions: string[]
  summary: string
  matched_contact_id: string | null
  matched_contact_name: string | null
  match_confidence: 'high' | 'medium' | 'low' | 'none'
}

export function TranscriptImporter() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [committing, setCommitting] = useState(false)

  function reset() {
    setText('')
    setPreview(null)
    setError(null)
  }

  function scan() {
    if (text.trim().length < 20) {
      setError('Paste a longer transcript first.')
      return
    }
    start(async () => {
      setError(null)
      const res = await fetch('/api/transcripts/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        preview?: Preview
      }
      if (!res.ok) {
        setError(data.error ?? 'Scan failed')
        return
      }
      setPreview(data.preview ?? null)
    })
  }

  function commit() {
    if (!preview?.matched_contact_id) {
      setError('No contact matched. Match a contact first.')
      return
    }
    setCommitting(true)
    start(async () => {
      const res = await fetch('/api/transcripts/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          commit: true,
          contact_id: preview.matched_contact_id,
        }),
      })
      setCommitting(false)
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? 'Import failed')
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
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-sm text-zinc-200 transition hover:border-violet-500 hover:text-white"
      >
        Import transcript
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-100">
          Import meeting transcript
        </h3>
        <button
          onClick={() => {
            reset()
            setOpen(false)
          }}
          className="text-xs text-zinc-500 hover:text-zinc-200"
        >
          Close
        </button>
      </div>

      <p className="mb-3 text-xs text-zinc-500">
        Paste a transcript from Otter, Fireflies, Read.ai, Zoom, Google Meet,
        or Teams. We&apos;ll extract participants, key points, action items,
        and decisions.
      </p>

      <textarea
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste transcript here…"
        className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
      />

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button
          onClick={scan}
          disabled={pending || text.trim().length < 20}
          className="rounded-md bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-violet-500/20 disabled:opacity-50"
        >
          {pending && !committing ? 'Scanning…' : 'Scan transcript'}
        </button>
      </div>

      {preview && (
        <div className="mt-5 space-y-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm">
          <Row
            label="Source"
            value={preview.source}
          />
          <Row
            label="Date"
            value={
              preview.date
                ? new Date(preview.date).toLocaleString()
                : 'unknown'
            }
          />
          <Row
            label="Participants"
            value={
              preview.participants.length > 0
                ? preview.participants.join(', ')
                : '(none detected)'
            }
          />
          <Row
            label="Match"
            value={
              preview.matched_contact_name
                ? `${preview.matched_contact_name} (${preview.match_confidence})`
                : 'no contact match — create the contact first'
            }
            highlight={preview.match_confidence === 'high'}
          />
          {preview.summary && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                Summary
              </div>
              <p className="mt-1 text-zinc-200">{preview.summary}</p>
            </div>
          )}
          {preview.key_points.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                Key points ({preview.key_points.length})
              </div>
              <ul className="mt-1 space-y-0.5 text-xs text-zinc-300">
                {preview.key_points.slice(0, 8).map((p, i) => (
                  <li key={i}>· {p}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.action_items.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                Action items ({preview.action_items.length})
              </div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {preview.action_items.map((a, i) => (
                  <li key={i}>
                    <span
                      className={
                        a.owner === 'me'
                          ? 'text-violet-300'
                          : 'text-fuchsia-300'
                      }
                    >
                      [{a.owner}]
                    </span>{' '}
                    <span className="text-zinc-300">{a.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button
            onClick={commit}
            disabled={pending || !preview.matched_contact_id}
            className="rounded-md bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-violet-500/20 disabled:opacity-50"
          >
            {committing
              ? 'Importing…'
              : preview.matched_contact_id
                ? 'Confirm & import'
                : 'Cannot import — no match'}
          </button>
        </div>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className={highlight ? 'text-emerald-300' : 'text-zinc-200'}>
        {value}
      </span>
    </div>
  )
}
