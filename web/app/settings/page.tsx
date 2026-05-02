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
import { APOLLO_PROVIDER } from '../../lib/apollo'

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

  const [profileRes, keysRes, integrationRes, apolloRes, gmailRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('preferred_model')
      .eq('id', user.id)
      .maybeSingle(),
    supabase
      .from('user_api_keys')
      .select('provider, api_key, is_active, updated_at')
      .eq('user_id', user.id),
    supabase
      .from('user_integrations')
      .select('account_email, last_synced_at')
      .eq('user_id', user.id)
      .eq('provider', 'google_contacts')
      .maybeSingle(),
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

  const googleContacts: GoogleContactsState = {
    account_email: integrationRes.data?.account_email ?? null,
    last_synced_at: integrationRes.data?.last_synced_at ?? null,
  }

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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <header className="mb-10 flex items-center justify-between">
          <div>
            <Link
              href="/"
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              ← Back to dashboard
            </Link>
            <h1 className="mt-2 text-2xl font-medium tracking-tight">Settings</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Choose your model and bring your own API keys.
            </p>
          </div>
          <div className="text-right text-xs text-zinc-500">
            <div>{user.email}</div>
          </div>
        </header>

        <SettingsClient
          allModels={MODELS}
          allProviders={PROVIDERS}
          preferredModel={preferredModel}
          existingKeys={keys}
        />

        <section className="mt-12">
          <div className="mb-4">
            <h2 className="text-base font-medium text-zinc-100">Integrations</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Connect external accounts to pull data into your relationship
              graph.
            </p>
          </div>
          <div className="space-y-3">
            <GoogleContactsCard state={googleContacts} />
            <ApolloCard state={apolloState} />
            <GmailSyncCard state={gmailState} />
          </div>
        </section>
      </div>
    </div>
  )
}
