import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { LIMITS, rateLimitOr429 } from '../../../../lib/rate-limit'
import {
  APOLLO_PROVIDER,
  ApolloAuthError,
  ApolloRateLimitError,
  buildEnrichmentPatch,
  matchPerson,
} from '../../../../lib/apollo'

export const dynamic = 'force-dynamic'

const MAX_BATCH = 10

type EnrichResultItem = {
  contact_id: string
  status: 'enriched' | 'not_found' | 'skipped' | 'error'
  fields_updated?: string[]
  error?: string
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const limited = rateLimitOr429(
    `contact-enrich:${user.id}`,
    LIMITS.CONTACT_ENRICH.limit,
    LIMITS.CONTACT_ENRICH.windowMs,
  )
  if (limited) return limited

  const body = (await req.json().catch(() => null)) as
    | { contact_ids?: unknown }
    | null
  const rawIds = Array.isArray(body?.contact_ids) ? body.contact_ids : null
  if (!rawIds || rawIds.length === 0) {
    return apiError(
      400,
      'contact_ids is required (non-empty array).',
      undefined,
      'invalid_request',
    )
  }
  const contactIds: string[] = rawIds
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, MAX_BATCH)
  if (contactIds.length === 0) {
    return apiError(
      400,
      'contact_ids must contain non-empty strings.',
      undefined,
      'invalid_request',
    )
  }
  if (rawIds.length > MAX_BATCH) {
    // Fall through, but signal in the response so the UI can warn.
  }

  const service = getServiceClient()
  if (!service) {
    return apiError(
      500,
      'Service role key not configured.',
      undefined,
      'service_unavailable',
    )
  }

  // Pull the API key from user_integrations (read through service client so
  // we don't depend on RLS exposing access_token to the user).
  const { data: integration, error: integrationError } = await service
    .from('user_integrations')
    .select('access_token')
    .eq('user_id', user.id)
    .eq('provider', APOLLO_PROVIDER)
    .maybeSingle()
  if (integrationError) {
    return apiError(
      500,
      integrationError.message,
      undefined,
      'integration_lookup_failed',
    )
  }
  const apiKey = integration?.access_token
  if (!apiKey || typeof apiKey !== 'string') {
    return apiError(
      400,
      'Apollo is not connected. Add your API key in Settings first.',
      undefined,
      'not_connected',
    )
  }

  const { data: contacts, error: contactsError } = await service
    .from('contacts')
    .select('id, first_name, last_name, email, company, title, phone, personal_details')
    .eq('user_id', user.id)
    .in('id', contactIds)
  if (contactsError) {
    return apiError(
      500,
      contactsError.message,
      undefined,
      'contacts_lookup_failed',
    )
  }

  type Row = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    company: string | null
    title: string | null
    phone: string | null
    personal_details: Record<string, unknown> | null
  }
  const rows = (contacts ?? []) as Row[]

  const results: EnrichResultItem[] = []

  // Sequential — Apollo's free tier is rate-limited and parallelism gives us
  // no real wall-clock win for batch sizes <=10.
  for (const id of contactIds) {
    const row = rows.find((r) => r.id === id)
    if (!row) {
      results.push({ contact_id: id, status: 'error', error: 'not_found' })
      continue
    }

    if (!row.email && !(row.first_name && row.last_name)) {
      results.push({
        contact_id: id,
        status: 'skipped',
        error: 'needs email or both first_name + last_name',
      })
      continue
    }

    let person
    try {
      person = await matchPerson(apiKey, {
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
      })
    } catch (err) {
      if (err instanceof ApolloAuthError) {
        // No point continuing the batch — every call will 401.
        return apiError(
          401,
          'Apollo rejected the saved API key. Re-enter it in Settings.',
          {
            results: [
              ...results,
              { contact_id: id, status: 'error', error: 'auth' },
            ],
          },
          'apollo_auth_failed',
        )
      }
      if (err instanceof ApolloRateLimitError) {
        results.push({ contact_id: id, status: 'error', error: 'rate_limited' })
        // Stop the batch — keep partial results so the user knows where we got.
        break
      }
      const message = err instanceof Error ? err.message : 'apollo_error'
      results.push({ contact_id: id, status: 'error', error: message })
      continue
    }

    if (!person) {
      results.push({ contact_id: id, status: 'not_found' })
      continue
    }

    const { patch } = buildEnrichmentPatch(person, {
      company: row.company,
      title: row.title,
      phone: row.phone,
      personal_details: row.personal_details,
    })

    if (Object.keys(patch).length === 0) {
      results.push({ contact_id: id, status: 'skipped' })
      continue
    }

    const { error: updateError } = await service
      .from('contacts')
      .update(patch)
      .eq('id', id)
      .eq('user_id', user.id)
    if (updateError) {
      results.push({
        contact_id: id,
        status: 'error',
        error: updateError.message,
      })
      continue
    }

    const fieldsUpdated = Object.keys(patch).filter(
      (k) => k !== 'personal_details',
    )
    if (patch.personal_details) fieldsUpdated.push('linkedin/details')
    results.push({
      contact_id: id,
      status: 'enriched',
      fields_updated: fieldsUpdated,
    })
  }

  await service
    .from('user_integrations')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('provider', APOLLO_PROVIDER)

  const summary = {
    requested: rawIds.length,
    processed: results.length,
    enriched: results.filter((r) => r.status === 'enriched').length,
    not_found: results.filter((r) => r.status === 'not_found').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errors: results.filter((r) => r.status === 'error').length,
    truncated: rawIds.length > MAX_BATCH,
    results,
  }

  return NextResponse.json(summary)
}
