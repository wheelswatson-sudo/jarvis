import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '../../lib/supabase/server'
import { DEFAULT_MODEL_ID, MODELS, PROVIDERS, type Provider } from '../../lib/providers'
import { SettingsClient } from './SettingsClient'
import {
  GoogleContactsCard,
  type GoogleContactsState,
} from './GoogleContactsCard'
import { ApolloCard, type ApolloState } from './ApolloCard'
import { GmailSyncCard, type GmailSyncState } from './GmailSyncCard'
import { CalendarSyncCard, type CalendarSyncState } from './CalendarSyncCard'
import { GoogleConnectCard, type GoogleService } from './GoogleConnectCard'
import { SmsGatewayCard, type SmsGatewayState } from './SmsGatewayCard'
import { APOLLO_PROVIDER } from '../../lib/apollo'
import { SMS_GATEWAY_PROVIDER } from '../../lib/sms/gateway'

export const dynamic = 'force-dynamic'

type ApiKeyRow = {
  provider: Provider
  masked: string
  is_active: boolean
  updated_at: string
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}${'•'.repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`
}

export default async function SettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [
    profileRes,
    keysRes,
    googleIntegrationsRes,
    apolloRes,
    gmailRes,
    smsRes,
    smsLastMessageRes,
  ] = await Promise.all([
      supabase
        .from('profiles')
        .select('preferred_model')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('user_api_keys')
        .select('provider, api_key, is_active, updated_at')
        .eq('user_id', user.id),
      // One query covering both the unified Google integration row
      // ('google', written by oauth.ts on token persist + the Gmail sync
      // route) AND the per-service rows ('google_contacts', 'google_calendar',
      // 'google_tasks', 'google_gmail') that other Google routes still
      // maintain. Gmail recently moved to writing only the unified row, so
      // its card prefers 'google' but falls back to 'google_gmail' for
      // backwards compat with any old row still living in the table.
      supabase
        .from('user_integrations')
        .select('provider, account_email, last_synced_at')
        .eq('user_id', user.id)
        .in('provider', [
          'google',
          'google_contacts',
          'google_calendar',
          'google_tasks',
          'google_gmail',
        ]),
      supabase
        .from('user_integrations')
        .select('access_token, last_synced_at')
        .eq('user_id', user.id)
        .eq('provider', APOLLO_PROVIDER)
        .maybeSingle(),
      supabase
        .from('interactions')
        .select('occurred_at')
        .eq('user_id', user.id)
        .like('source', 'gmail:%')
        .order('occurred_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('user_integrations')
        .select('access_token, last_synced_at, metadata')
        .eq('user_id', user.id)
        .eq('provider', SMS_GATEWAY_PROVIDER)
        .maybeSingle(),
      supabase
        .from('messages')
        .select('sent_at')
        .eq('user_id', user.id)
        .eq('channel', 'sms')
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

  const preferredModel = profileRes.data?.preferred_model ?? DEFAULT_MODEL_ID

  const validProviders = new Set<Provider>(PROVIDERS.map((p) => p.id))
  const keys: ApiKeyRow[] = (keysRes.data ?? [])
    .filter((k): k is { provider: string; api_key: string; is_active: boolean; updated_at: string } =>
      typeof k.provider === 'string' &&
      typeof k.api_key === 'string' &&
      validProviders.has(k.provider as Provider),
    )
    .map((k) => ({
      provider: k.provider as Provider,
      masked: maskKey(k.api_key),
      is_active: k.is_active,
      updated_at: k.updated_at,
    }))

  type IntegrationRow = {
    provider: string
    account_email: string | null
    last_synced_at: string | null
  }
  const googleRows: IntegrationRow[] =
    (googleIntegrationsRes.data as IntegrationRow[] | null) ?? []
  const byProvider = new Map<string, IntegrationRow>(
    googleRows.map((r) => [r.provider, r]),
  )

  const contactsRow = byProvider.get('google_contacts')
  const googleContacts: GoogleContactsState = {
    account_email: contactsRow?.account_email ?? null,
    last_synced_at: contactsRow?.last_synced_at ?? null,
  }

  // Best-effort account email — pick the first row that has one. The
  // contacts route is the only one that records account_email today, but
  // future Gmail/Calendar/Tasks routes can populate it too.
  const accountEmail =
    googleRows.find((r) => r.account_email)?.account_email ?? null

  // Gmail's interactive sync now writes the unified 'google' row. Prefer
  // it; fall back to a stale 'google_gmail' row (legacy writes from before
  // commit 2a39580) and finally to the latest gmail-source interaction
  // timestamp so the card never goes blank on a fresh account.
  const gmailUnified = byProvider.get('google')
  const gmailLegacy = byProvider.get('google_gmail')
  const googleServices: GoogleService[] = [
    {
      key: 'gmail',
      label: 'Gmail',
      last_synced_at:
        gmailUnified?.last_synced_at ??
        gmailLegacy?.last_synced_at ??
        gmailRes.data?.occurred_at ??
        null,
      account_email:
        gmailUnified?.account_email ??
        gmailLegacy?.account_email ??
        null,
    },
    {
      key: 'calendar',
      label: 'Calendar',
      last_synced_at: byProvider.get('google_calendar')?.last_synced_at ?? null,
      account_email: byProvider.get('google_calendar')?.account_email ?? null,
    },
    {
      key: 'tasks',
      label: 'Tasks',
      last_synced_at: byProvider.get('google_tasks')?.last_synced_at ?? null,
      account_email: byProvider.get('google_tasks')?.account_email ?? null,
    },
    {
      key: 'contacts',
      label: 'Contacts',
      last_synced_at: contactsRow?.last_synced_at ?? null,
      account_email: contactsRow?.account_email ?? null,
    },
  ]

  const apolloApiKey =
    typeof apolloRes.data?.access_token === 'string'
      ? apolloRes.data.access_token
      : null
  const apolloState: ApolloState = {
    connected: !!apolloApiKey,
    masked_key: apolloApiKey ? maskKey(apolloApiKey) : null,
    last_synced_at: apolloRes.data?.last_synced_at ?? null,
  }

  const gmailState: GmailSyncState = {
    last_synced_at: gmailRes.data?.occurred_at ?? null,
  }

  const calendarState: CalendarSyncState = {
    last_synced_at: byProvider.get('google_calendar')?.last_synced_at ?? null,
  }

  const smsRow = smsRes.data as
    | {
        access_token: string | null
        last_synced_at: string | null
        metadata: { gateway_url?: unknown; username?: unknown } | null
      }
    | null
  const smsApiKey =
    typeof smsRow?.access_token === 'string' ? smsRow.access_token : null
  const smsMeta = (smsRow?.metadata ?? {}) as {
    gateway_url?: unknown
    username?: unknown
  }
  const smsState: SmsGatewayState = {
    connected: !!smsApiKey,
    gateway_url:
      typeof smsMeta.gateway_url === 'string' ? smsMeta.gateway_url : null,
    username: typeof smsMeta.username === 'string' ? smsMeta.username : null,
    masked_key: smsApiKey ? maskKey(smsApiKey) : null,
    last_synced_at: smsRow?.last_synced_at ?? null,
    last_message_at: smsLastMessageRes.data?.sent_at ?? null,
  }

  // The webhook URL the user pastes into the SMS gateway app. Resolved on
  // the server so each Vercel preview/prod deployment shows the right host.
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    'http://localhost:3000'
  const smsWebhookUrl = `${baseUrl.replace(/\/$/, '')}/api/sms/webhook`

  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#07070b] text-zinc-100">
      <div className="aiea-aurora-bg" aria-hidden="true" />
      <div className="aiea-grid pointer-events-none fixed inset-0 z-0 opacity-50" aria-hidden="true" />
      <div className="relative z-10 mx-auto max-w-3xl px-6 py-12 animate-fade-up">
        <header className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-200"
            >
              <span aria-hidden="true">←</span> Back to dashboard
            </Link>
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-violet-500/25 bg-violet-500/[0.08] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-violet-200">
              <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400" />
              Configuration
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight aiea-gradient-text sm:text-4xl">
              Settings
            </h1>
            <p className="mt-2 text-sm text-zinc-400">
              Choose your model and bring your own API keys.
            </p>
          </div>
          <div className="text-right text-xs text-zinc-500">
            <div className="font-mono">{user.email}</div>
          </div>
        </header>

        <SettingsClient
          allModels={MODELS}
          allProviders={PROVIDERS}
          preferredModel={preferredModel}
          existingKeys={keys}
        />

        <section className="mt-12">
          <div className="mb-5">
            <h2 className="text-lg font-medium tracking-tight text-zinc-100">
              Integrations
            </h2>
            <p className="mt-1 max-w-xl text-sm text-zinc-400">
              Connect external accounts to pull data into your relationship
              graph.
            </p>
          </div>
          <div className="space-y-3">
            <GoogleConnectCard
              account_email={accountEmail}
              services={googleServices}
            />
            <GmailSyncCard state={gmailState} />
            <CalendarSyncCard state={calendarState} />
            <GoogleContactsCard state={googleContacts} />
            <SmsGatewayCard
              state={smsState}
              webhook_url={smsWebhookUrl}
              user_id={user.id}
            />
            <ApolloCard state={apolloState} />
          </div>
        </section>
      </div>
    </div>
  )
}
