import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { APOLLO_PROVIDER } from '../../../../lib/apollo'

export const dynamic = 'force-dynamic'

// ----------------------------------------------------------------------------
// POST — store / replace the Apollo API key for the authenticated user.
// Body: { api_key: string }
// ----------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const body = (await req.json().catch(() => null)) as
    | { api_key?: unknown }
    | null
  const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
  if (!apiKey) {
    return apiError(400, 'api_key is required.', undefined, 'invalid_request')
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

  const { error: upsertError } = await service
    .from('user_integrations')
    .upsert(
      {
        user_id: user.id,
        provider: APOLLO_PROVIDER,
        // The Apollo "API key" is a long-lived account-scoped credential —
        // we store it in access_token per the schema's existing field.
        access_token: apiKey,
        refresh_token: null,
        access_token_expires_at: null,
        scopes: ['people:match'],
      },
      { onConflict: 'user_id,provider' },
    )

  if (upsertError) {
    return apiError(500, upsertError.message, undefined, 'persist_failed')
  }

  return NextResponse.json({ ok: true })
}

// ----------------------------------------------------------------------------
// DELETE — remove the Apollo connection for this user.
// ----------------------------------------------------------------------------
export async function DELETE() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const { error } = await supabase
    .from('user_integrations')
    .delete()
    .eq('user_id', user.id)
    .eq('provider', APOLLO_PROVIDER)

  if (error) {
    return apiError(500, error.message, undefined, 'disconnect_failed')
  }

  return NextResponse.json({ ok: true })
}
