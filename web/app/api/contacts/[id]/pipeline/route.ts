import { NextResponse } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'
import { apiError } from '../../../../../lib/api-errors'
import { trackEvent } from '../../../../../lib/events'
import { PIPELINE_STAGES, type PipelineStage } from '../../../../../lib/types'

export const dynamic = 'force-dynamic'

const STAGE_SET = new Set<string>(PIPELINE_STAGES)

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
  }
  const b = (body ?? {}) as Record<string, unknown>

  const updates: { pipeline_stage?: PipelineStage | null; pipeline_notes?: string | null } = {}

  if ('pipeline_stage' in b) {
    const raw = b.pipeline_stage
    if (raw === null || raw === '') {
      updates.pipeline_stage = null
    } else if (typeof raw === 'string' && STAGE_SET.has(raw)) {
      updates.pipeline_stage = raw as PipelineStage
    } else {
      return apiError(
        400,
        `pipeline_stage must be one of ${PIPELINE_STAGES.join(', ')} or null`,
        undefined,
        'invalid_stage',
      )
    }
  }

  if ('pipeline_notes' in b) {
    const raw = b.pipeline_notes
    if (raw === null || raw === '') {
      updates.pipeline_notes = null
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed.length > 2000) {
        return apiError(400, 'pipeline_notes too long (max 2000 chars)', undefined, 'notes_too_long')
      }
      updates.pipeline_notes = trimmed.length === 0 ? null : trimmed
    } else {
      return apiError(400, 'pipeline_notes must be a string or null', undefined, 'invalid_notes')
    }
  }

  if (Object.keys(updates).length === 0) {
    return apiError(400, 'no fields to update', undefined, 'no_updates')
  }

  const { data, error } = await supabase
    .from('contacts')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id, pipeline_stage, pipeline_notes, pipeline_updated_at')
    .maybeSingle()

  if (error) return apiError(400, error.message, undefined, 'update_failed')
  if (!data) return apiError(404, 'Contact not found', undefined, 'contact_not_found')

  void trackEvent({
    userId: user.id,
    eventType: 'contact_updated',
    contactId: id,
    metadata: { field: 'pipeline', stage: data.pipeline_stage },
  })

  return NextResponse.json({ contact: data })
}
