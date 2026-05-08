'use client'

import { useMemo, useState, useTransition } from 'react'
import { createClient } from '../../../lib/supabase/client'
import { Card, PageHeader, EmptyState } from '../../../components/cards'
import { formatDate, formatRelative } from '../../../lib/format'
import { useTrackEvent } from '../../../lib/use-track-event'

export type FeedbackRow = {
  id: string
  user_id: string
  requester_email: string | null
  title: string
  description: string
  category: 'bug' | 'feature' | 'improvement'
  status: 'open' | 'in-progress' | 'shipped' | 'wont-fix'
  admin_response: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

type Props = {
  currentUserId: string | null
  currentUserEmail: string | null
  isAdmin: boolean
  initialRows: FeedbackRow[]
}

const CATEGORIES: FeedbackRow['category'][] = ['bug', 'feature', 'improvement']
const STATUSES: FeedbackRow['status'][] = [
  'open',
  'in-progress',
  'shipped',
  'wont-fix',
]

const STATUS_STYLE: Record<FeedbackRow['status'], string> = {
  open: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  'in-progress': 'border-blue-500/30 bg-blue-500/10 text-blue-200',
  shipped: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  'wont-fix': 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
}

const STATUS_LABEL: Record<FeedbackRow['status'], string> = {
  open: 'Open',
  'in-progress': 'In progress',
  shipped: 'Shipped',
  'wont-fix': "Won't fix",
}

const CATEGORY_STYLE: Record<FeedbackRow['category'], string> = {
  bug: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  feature: 'border-violet-500/30 bg-violet-500/10 text-violet-200',
  improvement: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200',
}

export function FeedbackView({
  currentUserId,
  currentUserEmail,
  isAdmin,
  initialRows,
}: Props) {
  const [rows, setRows] = useState<FeedbackRow[]>(initialRows)
  const [tab, setTab] = useState<'requests' | 'changelog'>('requests')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<FeedbackRow['category']>('feature')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const track = useTrackEvent()

  const visibleRows = useMemo(() => {
    if (tab === 'changelog') return rows.filter((r) => r.status === 'shipped')
    return rows
  }, [rows, tab])

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!currentUserId) return
    if (!title.trim() || !description.trim()) {
      setSubmitError('Title and description are required.')
      return
    }
    setSubmitError(null)
    setSubmitting(true)
    track('feedback_submit', { category })
    const supabase = createClient()
    const { data, error } = await supabase
      .from('feedback')
      .insert({
        user_id: currentUserId,
        requester_email: currentUserEmail,
        title: title.trim(),
        description: description.trim(),
        category,
      })
      .select(
        'id, user_id, requester_email, title, description, category, status, admin_response, resolved_at, created_at, updated_at',
      )
      .single()
    setSubmitting(false)
    if (error || !data) {
      setSubmitError(error?.message ?? 'Could not submit. Try again.')
      return
    }
    setRows((prev) => [data as FeedbackRow, ...prev])
    setTitle('')
    setDescription('')
    setCategory('feature')
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Feedback"
        title="Tell us what to build next"
        subtitle="Submit bugs, feature ideas, and improvements. Track what's been requested and what's shipped."
      />

      <Card>
        <h2 className="text-base font-medium text-zinc-100">Submit a request</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Be specific about the problem and the outcome you want.
        </p>
        <form onSubmit={onSubmit} className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="feedback-title"
              className="block text-xs font-medium uppercase tracking-wider text-zinc-400"
            >
              Title
            </label>
            <input
              id="feedback-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              placeholder="One-line summary"
              className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
            />
          </div>
          <div>
            <label
              htmlFor="feedback-description"
              className="block text-xs font-medium uppercase tracking-wider text-zinc-400"
            >
              Description
            </label>
            <textarea
              id="feedback-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              rows={4}
              placeholder="What were you trying to do? What happened? What did you expect?"
              className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
            />
          </div>
          <div>
            <label
              htmlFor="feedback-category"
              className="block text-xs font-medium uppercase tracking-wider text-zinc-400"
            >
              Category
            </label>
            <select
              id="feedback-category"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as FeedbackRow['category'])
              }
              className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c} className="bg-[#0b0b12]">
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </div>
          {submitError && (
            <p className="text-sm text-rose-300">{submitError}</p>
          )}
          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={submitting}
              data-track-click="feedback_submit_button"
              className="rounded-lg border border-violet-400/30 bg-gradient-to-r from-indigo-500/20 via-violet-500/20 to-fuchsia-500/20 px-4 py-2 text-sm font-medium text-violet-100 transition-colors hover:border-violet-400/50 hover:text-white disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      </Card>

      <div>
        <div
          className="mb-5 inline-flex rounded-xl border border-white/[0.06] bg-white/[0.02] p-1"
          role="tablist"
          aria-label="Feedback views"
        >
          <button
            role="tab"
            aria-selected={tab === 'requests'}
            onClick={() => setTab('requests')}
            className={`rounded-lg px-4 py-1.5 text-sm transition-colors ${
              tab === 'requests'
                ? 'bg-white/[0.06] text-white'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            Requests
            <span className="ml-2 text-xs text-zinc-500">{rows.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'changelog'}
            onClick={() => setTab('changelog')}
            className={`rounded-lg px-4 py-1.5 text-sm transition-colors ${
              tab === 'changelog'
                ? 'bg-white/[0.06] text-white'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            Changelog
            <span className="ml-2 text-xs text-zinc-500">
              {rows.filter((r) => r.status === 'shipped').length}
            </span>
          </button>
        </div>

        {visibleRows.length === 0 ? (
          <EmptyState
            title={tab === 'changelog' ? 'Nothing shipped yet' : 'No requests yet'}
            body={
              tab === 'changelog'
                ? 'Items will appear here once they ship.'
                : 'Be the first to submit a request above.'
            }
          />
        ) : (
          <ul className="space-y-4">
            {visibleRows.map((row) => (
              <FeedbackItem
                key={row.id}
                row={row}
                isAdmin={isAdmin}
                onUpdate={(updated) =>
                  setRows((prev) =>
                    prev.map((r) => (r.id === updated.id ? updated : r)),
                  )
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function FeedbackItem({
  row,
  isAdmin,
  onUpdate,
}: {
  row: FeedbackRow
  isAdmin: boolean
  onUpdate: (next: FeedbackRow) => void
}) {
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const [draftStatus, setDraftStatus] = useState<FeedbackRow['status']>(
    row.status,
  )
  const [draftResponse, setDraftResponse] = useState(row.admin_response ?? '')
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    const supabase = createClient()
    // resolved_at is owned by the sync_feedback_resolved_at trigger
    // (migration 019) — set on transition into shipped|wont-fix, cleared
    // on the way out. The .select() below pulls the trigger's value back.
    const patch: Partial<FeedbackRow> = {
      status: draftStatus,
      admin_response: draftResponse.trim() || null,
    }
    const { data, error: updateError } = await supabase
      .from('feedback')
      .update(patch)
      .eq('id', row.id)
      .select(
        'id, user_id, requester_email, title, description, category, status, admin_response, resolved_at, created_at, updated_at',
      )
      .single()
    if (updateError || !data) {
      setError(updateError?.message ?? 'Save failed')
      return
    }
    onUpdate(data as FeedbackRow)
    setEditing(false)
  }

  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-medium text-zinc-100">
                {row.title}
              </h3>
              <StatusBadge status={row.status} />
              <CategoryBadge category={row.category} />
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              <span>{row.requester_email ?? 'Anonymous'}</span>
              <span className="px-1.5">·</span>
              <span title={formatDate(row.created_at)}>
                {formatRelative(row.created_at)}
              </span>
            </div>
          </div>
          {isAdmin && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs text-zinc-300 hover:border-white/20 hover:text-white"
            >
              Edit
            </button>
          )}
        </div>

        <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-300">
          {row.description}
        </p>

        {row.admin_response && !editing && (
          <div className="mt-4 rounded-xl border border-violet-400/20 bg-violet-500/[0.04] p-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-violet-300">
              Watson&apos;s response
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-200">
              {row.admin_response}
            </p>
          </div>
        )}

        {isAdmin && editing && (
          <div className="mt-4 space-y-3 border-t border-white/[0.06] pt-4">
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-wider text-zinc-400">
                Status
              </label>
              <select
                value={draftStatus}
                onChange={(e) =>
                  setDraftStatus(e.target.value as FeedbackRow['status'])
                }
                className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s} className="bg-[#0b0b12]">
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-wider text-zinc-400">
                Response
              </label>
              <textarea
                value={draftResponse}
                onChange={(e) => setDraftResponse(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100"
              />
            </div>
            {error && <p className="text-sm text-rose-300">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                  setDraftStatus(row.status)
                  setDraftResponse(row.admin_response ?? '')
                  setError(null)
                }}
                className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-100"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => void save())}
                className="rounded-md border border-violet-400/30 bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-violet-100 hover:border-violet-400/50 hover:text-white disabled:opacity-50"
              >
                {pending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </Card>
    </li>
  )
}

function StatusBadge({ status }: { status: FeedbackRow['status'] }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}

function CategoryBadge({ category }: { category: FeedbackRow['category'] }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${CATEGORY_STYLE[category]}`}
    >
      {category}
    </span>
  )
}
