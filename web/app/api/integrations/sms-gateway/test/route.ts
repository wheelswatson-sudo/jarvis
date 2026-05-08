import { NextResponse } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'
import { getServiceClient } from '../../../../../lib/supabase/service'
import { apiError } from '../../../../../lib/api-errors'
import {
  SMS_GATEWAY_PROVIDER,
  fetchHistoricalMessages,
  type SmsGatewayConfig,
} from '../../../../../lib/sms/gateway'

export const dynamic = 'force-dynamic'

// POST — probe the saved gateway with a single-message request so the
// settings UI can show "reachable" / "creds rejected" without ingesting
// anything. Mirrors the same auth/URL handling as /api/sms/sync.
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service role key not configured.', undefined, 'service_unavailable')
  }

  const { data: integration } = await service
    .from('user_integrations')
    .select('access_token, metadata')
    .eq('user_id', user.id)
    .eq('provider', SMS_GATEWAY_PROVIDER)
    .maybeSingle()

  if (!integration?.access_token) {
    return apiError(
      400,
      'No SMS gateway connected. Save your credentials first.',
      undefined,
      'not_connected',
    )
  }

  const meta = (integration.metadata ?? {}) as {
    gateway_url?: unknown
    username?: unknown
  }
  const gatewayUrl =
    typeof meta.gateway_url === 'string' ? meta.gateway_url : ''
  if (!gatewayUrl) {
    return apiError(
      400,
      'Saved gateway is missing its base URL. Reconfigure it.',
      undefined,
      'misconfigured',
    )
  }

  const config: SmsGatewayConfig = {
    baseUrl: gatewayUrl,
    username:
      typeof meta.username === 'string' && meta.username ? meta.username : 'sms',
    apiKey: integration.access_token,
  }

  try {
    const messages = await fetchHistoricalMessages(config, { limit: 1 })
    return NextResponse.json({
      ok: true,
      reachable: true,
      sample_count: messages.length,
    })
  } catch (err) {
    return apiError(
      502,
      err instanceof Error ? err.message : 'Gateway request failed.',
      undefined,
      'gateway_unreachable',
    )
  }
}
