'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { pipelineStageColor } from '../lib/format'
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  type Contact,
  type PipelineStage,
} from '../lib/types'

export function PipelineSelector({ contact }: { contact: Contact }) {
  const router = useRouter()
  const [stage, setStage] = useState<PipelineStage | null>(contact.pipeline_stage)
  const [notes, setNotes] = useState(contact.pipeline_notes ?? '')
  const [savedNotes, setSavedNotes] = useState(contact.pipeline_notes ?? '')
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function persist(payload: {
    pipeline_stage?: PipelineStage | null
    pipeline_notes?: string | null
  }) {
    start(async () => {
      setError(null)
      const res = await fetch(`/api/contacts/${contact.id}/pipeline`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        setError(j.error ?? 'Failed to save')
        return
      }
      router.refresh()
    })
  }

  function setStageAndPersist(next: PipelineStage | null) {
    setStage(next)
    persist({ pipeline_stage: next })
  }

  function commitNotes() {
    if (notes.trim() === savedNotes.trim()) return
    const value = notes.trim() === '' ? null : notes.trim()
    setSavedNotes(value ?? '')
    persist({ pipeline_notes: value })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {PIPELINE_STAGES.map((s) => {
          const active = s === stage
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStageAndPersist(active ? null : s)}
              disabled={pending}
              aria-pressed={active}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
                active
                  ? pipelineStageColor(s)
                  : 'bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 ring-1 ring-inset ring-white/[0.06]'
              } ${pending ? 'opacity-60' : ''}`}
            >
              {PIPELINE_STAGE_LABELS[s]}
            </button>
          )
        })}
        {stage && (
          <button
            type="button"
            onClick={() => setStageAndPersist(null)}
            disabled={pending}
            className="rounded-full px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-200"
          >
            Clear
          </button>
        )}
      </div>

      <div>
        <label
          htmlFor={`pipeline-notes-${contact.id}`}
          className="mb-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500"
        >
          Status notes
        </label>
        <textarea
          id={`pipeline-notes-${contact.id}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={commitNotes}
          placeholder="Context for this status — blockers, next move, anything you want surfaced…"
          rows={2}
          maxLength={2000}
          className="w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-600">
          <span>{pending ? 'Saving…' : 'Saved on blur'}</span>
          <span className="tabular-nums">{notes.length}/2000</span>
        </div>
      </div>

      {error && (
        <p className="text-xs text-rose-300">{error}</p>
      )}
    </div>
  )
}
