// Thin client + shared types for the SMS Gateway for Android API.
// Spec: https://docs.sms-gate.app/
//
// The gateway runs either on the user's phone (local mode, basic auth on a
// LAN URL) or in their cloud account (cloud mode, basic auth on
// https://api.sms-gate.app or a self-hosted public URL). Same wire format
// either way — only the base URL and credentials differ.

export const SMS_GATEWAY_PROVIDER = 'sms_gateway'
export const SMS_CHANNEL = 'sms' as const

// What we persist in user_integrations for this provider:
//   access_token = the gateway API key (basic-auth password)
//   metadata.gateway_url = base URL like https://api.sms-gate.app/3rdparty/v1
//   metadata.username = basic-auth username (gateway default is "sms")
export type SmsGatewayConfig = {
  baseUrl: string
  username: string
  apiKey: string
}

export type SmsGatewayEvent =
  | 'sms:received'
  | 'sms:sent'
  | 'sms:delivered'
  | 'sms:failed'

export type SmsGatewayWebhookPayload = {
  messageId?: string
  phoneNumber?: string
  message?: string
  receivedAt?: string
  phoneNumbers?: string[]
  sentAt?: string
  deliveredAt?: string
  text?: string
}

export type SmsGatewayWebhookEnvelope = {
  id?: string
  event: SmsGatewayEvent | string
  payload: SmsGatewayWebhookPayload
  webhookId?: string
  occurredAt?: string
}

// `GET /messages` shape from the gateway. Schema documented at
// https://docs.sms-gate.app/integration/api/. We accept both single- and
// multi-recipient variants and tolerate optional fields.
export type SmsGatewayMessage = {
  id: string
  phoneNumber?: string
  phoneNumbers?: string[]
  message?: string
  text?: string
  state?: 'Pending' | 'Sent' | 'Delivered' | 'Failed' | string
  receivedAt?: string
  sentAt?: string
  deliveredAt?: string
  createdAt?: string
  direction?: 'inbound' | 'outbound' | 'Inbound' | 'Outbound'
}

export async function fetchHistoricalMessages(
  config: SmsGatewayConfig,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<SmsGatewayMessage[]> {
  const limit = options.limit ?? 100
  const url = new URL('messages', ensureTrailingSlash(config.baseUrl))
  url.searchParams.set('limit', String(limit))

  const auth = Buffer.from(
    `${config.username}:${config.apiKey}`,
    'utf-8',
  ).toString('base64')

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
    signal: options.signal,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `SMS gateway responded ${res.status}: ${detail.slice(0, 200) || res.statusText}`,
    )
  }

  const data = (await res.json().catch(() => null)) as
    | SmsGatewayMessage[]
    | { messages?: SmsGatewayMessage[] }
    | null

  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.messages)) return data.messages
  return []
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

export function pickOccurredAt(msg: SmsGatewayMessage): string {
  const candidate =
    msg.deliveredAt ??
    msg.sentAt ??
    msg.receivedAt ??
    msg.createdAt ??
    new Date().toISOString()
  const d = new Date(candidate)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

export function pickBody(
  msg: SmsGatewayMessage | SmsGatewayWebhookPayload,
): string {
  const body = ('message' in msg ? msg.message : undefined) ?? msg.text ?? ''
  return body
}

export function pickCounterpartyPhone(
  msg: SmsGatewayMessage | SmsGatewayWebhookPayload,
): string | null {
  if (msg.phoneNumber) return msg.phoneNumber
  const list = msg.phoneNumbers
  if (Array.isArray(list) && list.length > 0) return list[0]
  return null
}

export function pickDirection(
  msg: SmsGatewayMessage,
): 'inbound' | 'outbound' {
  const d = msg.direction?.toLowerCase()
  if (d === 'inbound') return 'inbound'
  return 'outbound'
}

export function eventToDirection(
  event: string,
): 'inbound' | 'outbound' | null {
  if (event === 'sms:received') return 'inbound'
  if (
    event === 'sms:sent' ||
    event === 'sms:delivered' ||
    event === 'sms:failed'
  ) {
    return 'outbound'
  }
  return null
}
