import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import {
  SMS_GATEWAY_PROVIDER,
  eventToDirection,
  pickBody,
  listCounterpartyPhones,
  type SmsGatewayWebhookEnvelope,
} from '../../../../lib/sms/gateway'
import { storeSmsMessages, type IncomingSms } from '../../../../lib/sms/ingest'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Webhook receiver for the SMS Gateway for Android. Two-layer auth:
//
//   1. Global shared secret (env: SMS_GATEWAY_WEBHOOK_SECRET) presented as
//      `Authorization: Bearer <secret>`. Coarse first gate.
//   2. Per-user routing (`?user_id=<uuid>`) verified against
//      user_integrations to confirm an active sms_gateway row exists.
//
// We always 200 the gateway when a request gets past auth — failures
// inside our system are our problem, not the gateway's. Replying non-2xx
// would just trigger gateway retries that don't fix the root cause.
export async function POST(req: NextRequest) {
  const expectedSecret = process.env.SMS_GATEWAY_WEBHOOK_SECRET
  if (!expectedSecret) {
    return apiError(
      503,
      'SMS webhook receiver not configured.',
      undefined,
      'webhook_disabled',
    )
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const presented = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : ''
  if (!presented || presented !== expectedSecret) {
    return apiError(401, 'Invalid webhook auth.', undefined, 'unauthorized')
  }

  const url = new URL(req.url)
  const userId = url.searchParams.get('user_id')?.trim() ?? ''
  if (!userId) {
    return apiError(400, 'user_id query param is required.', undefined, 'invalid_request')
  }

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service role key not configured.', undefined, 'service_unavailable')
  }

  const { data: integration, error: integrationErr } = await service
    .from('user_integrations')
    .select('user_id')
    .eq('user_id', userId)
    .eq('provider', SMS_GATEWAY_PROVIDER)
    .maybeSingle()
  if (integrationErr) {
    console.warn('[sms-webhook] integration lookup failed:', integrationErr.message)
    return apiError(500, 'Integration lookup failed.', undefined, 'lookup_failed')
  }
  if (!integration) {
    return apiError(404, 'No SMS gateway connected for this user.', undefined, 'not_connected')
  }

  const raw = (await req.json().catch(() => null)) as unknown
  if (!raw || typeof raw !== 'object') {
    return apiError(400, 'Invalid webhook envelope.', undefined, 'invalid_request')
  }
  const envelope = raw as SmsGatewayWebhookEnvelope
  if (
    typeof envelope.event !== 'string' ||
    !envelope.payload ||
    typeof envelope.payload !== 'object'
  ) {
    return apiError(400, 'Invalid webhook envelope.', undefined, 'invalid_request')
  }

  const direction = eventToDirection(envelope.event)
  if (!direction) {
    return NextResponse.json({ ok: true, ignored: 'unsupported_event' })
  }

  const gatewayId = envelope.payload.messageId ?? envelope.id
  if (!gatewayId) {
    return apiError(400, 'payload.messageId is required.', undefined, 'invalid_request')
  }

  const body = pickBody(envelope.payload)
  const phones = listCounterpartyPhones(envelope.payload)
  if (phones.length === 0) {
    return NextResponse.json({ ok: true, ignored: 'no_phone' })
  }

  const occurredCandidate =
    envelope.payload.deliveredAt ??
    envelope.payload.sentAt ??
    envelope.payload.receivedAt ??
    envelope.occurredAt ??
    new Date().toISOString()
  const occurredDate = new Date(occurredCandidate)
  const occurredAt = Number.isNaN(occurredDate.getTime())
    ? new Date().toISOString()
    : occurredDate.toISOString()

  // Group SMS: one row per recipient so each matched contact gets its own
  // last_interaction_at bump. external_id stays unique by suffixing index.
  const messages: IncomingSms[] = phones.map((phone, idx) => ({
    gatewayId: phones.length === 1 ? gatewayId : `${gatewayId}#${idx}`,
    direction,
    counterpartyPhone: phone,
    body,
    occurredAt,
  }))

  const result = await storeSmsMessages(service, userId, messages)

  return NextResponse.json({
    ok: true,
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors,
    reports: result.reports,
  })
}
