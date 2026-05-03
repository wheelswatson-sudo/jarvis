// Mirror Google Tasks into the commitments table.
//
// Mapping:
//   task.title       → commitments.description
//   task.notes       → commitments.notes
//   task.due         → commitments.due_at         (Google Tasks stores
//                                                  date-only, midnight UTC)
//   task.status      → commitments.status         (needsAction → 'open',
//                                                  completed   → 'done')
//   task.completed   → commitments.completed_at
//
// Dedup happens via the unique index on (user_id, source, external_id) where
// source = 'google_tasks' and external_id = task.id. We upsert so a re-sync
// updates description / status / due_at in place.

import { google } from 'googleapis'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildOAuthClient } from './oauth'

const SOURCE = 'google_tasks'

export type TasksSyncOptions = {
  /** Tasklist id. Defaults to '@default' (the user's primary list). */
  tasklist?: string
  /** Include completed tasks too. Defaults to true so we mirror state. */
  includeCompleted?: boolean
  /** Cap how many tasks we process per run. Defaults to 200. */
  maxResults?: number
}

export type TasksSyncResult = {
  fetched: number
  upserted: number
  skipped: number
  errors: number
}

type TaskItem = {
  id?: string | null
  title?: string | null
  notes?: string | null
  status?: string | null
  due?: string | null
  completed?: string | null
}

export async function syncTasksForUser(
  service: SupabaseClient,
  userId: string,
  accessToken: string,
  opts: TasksSyncOptions = {},
): Promise<TasksSyncResult> {
  const tasklist = opts.tasklist ?? '@default'
  const includeCompleted = opts.includeCompleted ?? true
  const maxResults = clampInt(opts.maxResults, 1, 1000, 200)

  const tasksApi = google.tasks({
    version: 'v1',
    auth: buildOAuthClient(accessToken),
  })

  const items: TaskItem[] = []
  let pageToken: string | undefined
  let pageCount = 0
  while (pageCount < 10) {
    const res = await tasksApi.tasks.list({
      tasklist,
      showCompleted: includeCompleted,
      showHidden: false,
      maxResults: Math.min(100, maxResults - items.length),
      pageToken,
    })
    items.push(...((res.data.items ?? []) as TaskItem[]))
    pageToken = res.data.nextPageToken ?? undefined
    pageCount++
    if (!pageToken || items.length >= maxResults) break
  }

  let upserted = 0
  let skipped = 0
  let errors = 0

  for (const t of items) {
    const externalId = t.id
    const description = (t.title ?? '').trim()
    if (!externalId || description.length === 0) {
      skipped++
      continue
    }

    const status = mapStatus(t.status)
    const dueAt = t.due ?? null
    const completedAt = t.completed ?? null

    const row = {
      user_id: userId,
      description,
      notes: t.notes ?? null,
      due_at: dueAt,
      status,
      completed_at: status === 'done' ? completedAt ?? new Date().toISOString() : null,
      owner: 'me' as const,
      source: SOURCE,
      external_id: externalId,
    }

    const { error } = await service
      .from('commitments')
      .upsert(row, { onConflict: 'user_id,source,external_id' })
    if (error) {
      errors++
      console.warn('[tasks-sync] upsert failed', {
        external_id: externalId,
        message: error.message,
      })
    } else {
      upserted++
    }
  }

  return { fetched: items.length, upserted, skipped, errors }
}

function mapStatus(raw: string | null | undefined): 'open' | 'done' {
  return raw === 'completed' ? 'done' : 'open'
}

function clampInt(
  raw: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}
