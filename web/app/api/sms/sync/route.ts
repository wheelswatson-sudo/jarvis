import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import {
  SMS_GATEWAY_PROVIDER,
  fetchHistoricalMessages,
  pickBody,
  pickCounterpartyPhone,
  pickDirection,
  pickOccurredAt,
  type SmsGatewayConfig,
  type SmsGatewayMessage,
} from '../../../../lib/sms/gateway'
import { storeSmsMessages, type IncomingSms } from '../../../../lib/sms/ingest'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

// POST — pull recent messages from the gateway and import them into the
// unified `messages` table. Mirrors the manual-sync UX of GmailSyncCard.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const body = (await req.json().catch(() => null)) as
    | { limit?: unknown }
    | null
  const requested = typeof body?.limit === 'number' ? body.limit : DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)))

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service role key not configured.', undefined, 'service_unavailable')
  }

  const { data: integration, error: integrationErr } = await service
    .from('user_integrations')
    .select('access_token, metadata')
    .eq('user_id', user.id)
    .eq('provider', SMS_GATEWAY_PROVIDER)
    .maybeSingle()
  if (integrationErr) {
    return apiError(500, integrationErr.message, undefined, 'lookup_failed')
  }
  if (!integration?.access_token) {
    return apiError(
      400,
      'No SMS gateway connected. Configure it in Settings first.',
      undefined,
      'not_connected',
    )
  }

  const meta = (integration.metadata ?? {}) as {
    gateway_url?: unknown
    username?: unknown
  }
  const gatewayUrl = typeof meta.gateway_url === 'string' ? meta.gateway_url : ''
  if (!gatewayUrl) {
    return apiError(
      400,
      'Saved SMS gateway is missing its base URL. Reconfigure it in Settings.',
      undefined,
      'misconfigured',
    )
  }

  const config: SmsGatewayConfig = {
    baseUrl: gatewayUrl,
    username: typeof meta.username === 'string' && meta.username ? meta.username : 'sms',
    apiKey: integration.access_token,
  }

  let raw: SmsGatewayMessage[]
  try {
    raw = await fetchHistoricalMessages(config, { limit })
  } catch (err) {
    return apiError(
      502,
      err instanceof Error ? err.message : 'Gateway request failed.',
      undefined,
      'gateway_error',
    )
  }

  const messages: IncomingSms[] = raw
    .filter((m): m is SmsGatewayMessage => !!m && typeof m.id === 'string')
    .map((m) => {
      const phone = pickCounterpartyPhone(m) ?? ''
      return {
        gatewayId: m.id,
        direction: pickDirection(m),
        counterpartyPhone: phone,
        body: pickBody(m),
        occurredAt: pickOccurredAt(m),
      }
    })
    .filter((m) => m.counterpartyPhone)

  const result = await storeSmsMessages(service, user.id, messages)

  await service
    .from('user_integrations')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('provider', SMS_GATEWAY_PROVIDER)

  const sampleSkipReasons = Array.from(
    new Set(
      result.reports
        .filter((r) => r.status === 'skipped')
        .map((r) => r.reason ?? 'unknown'),
    ),
  ).slice(0, 5)
  const unmatchedCount = result.reports.filter(
    (r) => r.status === 'imported' && r.reason === 'no_matching_contact',
  ).length

  return NextResponse.json({
    fetched: raw.length,
    candidates: messages.length,
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors,
    unmatched_contact: unmatchedCount,
    sample_skip_reasons: sampleSkipReasons,
  })
}
