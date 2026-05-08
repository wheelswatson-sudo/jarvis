import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { SMS_GATEWAY_PROVIDER } from '../../../../lib/sms/gateway'

export const dynamic = 'force-dynamic'

// POST — store / replace the SMS gateway connection for the authenticated
// user. Body: { gateway_url: string, username?: string, api_key: string }
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const body = (await req.json().catch(() => null)) as
    | { gateway_url?: unknown; username?: unknown; api_key?: unknown }
    | null

  const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
  const gatewayUrl =
    typeof body?.gateway_url === 'string' ? body.gateway_url.trim() : ''
  const username =
    typeof body?.username === 'string' && body.username.trim()
      ? body.username.trim()
      : 'sms'

  if (!apiKey) {
    return apiError(400, 'api_key is required.', undefined, 'invalid_request')
  }
  if (!gatewayUrl) {
    return apiError(
      400,
      'gateway_url is required (e.g., https://api.sms-gate.app/3rdparty/v1).',
      undefined,
      'invalid_request',
    )
  }
  try {
    new URL(gatewayUrl)
  } catch {
    return apiError(400, 'gateway_url must be a valid URL.', undefined, 'invalid_request')
  }

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service role key not configured.', undefined, 'service_unavailable')
  }

  const { error: upsertError } = await service
    .from('user_integrations')
    .upsert(
      {
        user_id: user.id,
        provider: SMS_GATEWAY_PROVIDER,
        access_token: apiKey,
        refresh_token: null,
        access_token_expires_at: null,
        scopes: ['messages:read', 'messages:write'],
        metadata: { gateway_url: gatewayUrl, username },
      },
      { onConflict: 'user_id,provider' },
    )

  if (upsertError) {
    return apiError(500, upsertError.message, undefined, 'persist_failed')
  }
  return NextResponse.json({ ok: true })
}

// DELETE — remove the SMS gateway connection.
export async function DELETE() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const { error } = await supabase
    .from('user_integrations')
    .delete()
    .eq('user_id', user.id)
    .eq('provider', SMS_GATEWAY_PROVIDER)

  if (error) {
    return apiError(500, error.message, undefined, 'disconnect_failed')
  }
  return NextResponse.json({ ok: true })
}
