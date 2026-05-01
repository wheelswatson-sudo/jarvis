import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { trackImport } from '../../../../lib/events'
import {
  GOOGLE_CONTACTS_PROVIDER,
  buildAuthUrl,
  buildOAuthClient,
  exchangeCode,
  fetchAllConnections,
  getConnectedAccountEmail,
  mapPersonToContact,
  readGoogleEnv,
  type MappedContact,
} from '../../../../lib/google/contacts'

export const dynamic = 'force-dynamic'

const STATE_COOKIE = 'google_contacts_oauth_state'
const STATE_COOKIE_MAX_AGE = 600 // 10 minutes

function redirectUriFor(req: NextRequest): string {
  const { origin } = new URL(req.url)
  return `${origin}/api/contacts/google`
}

function settingsRedirect(
  req: NextRequest,
  params: Record<string, string>,
): NextResponse {
  const { origin } = new URL(req.url)
  const url = new URL(`${origin}/settings`)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return NextResponse.redirect(url)
}

// ----------------------------------------------------------------------------
// GET — dual purpose: initiate OAuth (no `code`) OR handle callback (`code`)
// ----------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const env = readGoogleEnv()
  if (!env) {
    return apiError(
      500,
      'Google Contacts integration is not configured on this server.',
      undefined,
      'google_oauth_not_configured',
    )
  }

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  // Google bounced the user back with an error (e.g. user denied consent).
  if (error) {
    return settingsRedirect(req, {
      google_contacts: 'error',
      reason: error,
    })
  }

  const oauth = buildOAuthClient(env, redirectUriFor(req))

  // ---- Initiate flow ----
  if (!code) {
    const cookieStore = await cookies()
    const state = crypto.randomUUID()
    cookieStore.set(STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: STATE_COOKIE_MAX_AGE,
    })
    return NextResponse.redirect(buildAuthUrl(oauth, state))
  }

  // ---- Callback flow ----
  const cookieStore = await cookies()
  const expectedState = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)
  if (!expectedState || expectedState !== stateParam) {
    return settingsRedirect(req, {
      google_contacts: 'error',
      reason: 'state_mismatch',
    })
  }

  let refreshToken: string | null = null
  let accessToken: string | null = null
  let accessTokenExpiresAt: string | null = null
  try {
    const tokens = await exchangeCode(oauth, code)
    refreshToken = tokens.refresh_token ?? null
    accessToken = tokens.access_token ?? null
    accessTokenExpiresAt = tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : null
    oauth.setCredentials(tokens)
  } catch {
    return settingsRedirect(req, {
      google_contacts: 'error',
      reason: 'token_exchange_failed',
    })
  }

  const accountEmail = await getConnectedAccountEmail(oauth)

  const service = getServiceClient()
  if (!service) {
    return apiError(
      500,
      'Service role key not configured.',
      undefined,
      'service_unavailable',
    )
  }

  // Look up any existing row so we can preserve a previously-saved
  // refresh_token if Google omitted one this round (it does that when the
  // same scopes were already granted; `prompt: 'consent'` mostly avoids
  // this but we defend against it anyway).
  const { data: existing } = await service
    .from('user_integrations')
    .select('refresh_token')
    .eq('user_id', user.id)
    .eq('provider', GOOGLE_CONTACTS_PROVIDER)
    .maybeSingle()

  const finalRefreshToken =
    refreshToken ?? existing?.refresh_token ?? null

  if (!finalRefreshToken) {
    return settingsRedirect(req, {
      google_contacts: 'error',
      reason: 'no_refresh_token',
    })
  }

  const { error: upsertError } = await service
    .from('user_integrations')
    .upsert(
      {
        user_id: user.id,
        provider: GOOGLE_CONTACTS_PROVIDER,
        account_email: accountEmail,
        refresh_token: finalRefreshToken,
        access_token: accessToken,
        access_token_expires_at: accessTokenExpiresAt,
        scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
      },
      { onConflict: 'user_id,provider' },
    )

  if (upsertError) {
    return settingsRedirect(req, {
      google_contacts: 'error',
      reason: 'persist_failed',
    })
  }

  return settingsRedirect(req, { google_contacts: 'connected' })
}

// ----------------------------------------------------------------------------
// POST — trigger a sync of Google Contacts into the contacts table
// ----------------------------------------------------------------------------
type SyncResult = {
  inserted: number
  updated: number
  skipped: number
  total_fetched: number
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const env = readGoogleEnv()
  if (!env) {
    return apiError(
      500,
      'Google Contacts integration is not configured on this server.',
      undefined,
      'google_oauth_not_configured',
    )
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

  // Read the integration row through the service client so we can write
  // back the refreshed access_token / last_synced_at on the same path.
  const { data: integration, error: integrationError } = await service
    .from('user_integrations')
    .select('refresh_token, account_email')
    .eq('user_id', user.id)
    .eq('provider', GOOGLE_CONTACTS_PROVIDER)
    .maybeSingle()

  if (integrationError) {
    return apiError(
      500,
      integrationError.message,
      undefined,
      'integration_lookup_failed',
    )
  }
  if (!integration?.refresh_token) {
    return apiError(
      400,
      'Google Contacts is not connected.',
      undefined,
      'not_connected',
    )
  }

  const oauth = buildOAuthClient(env, redirectUriFor(req))
  oauth.setCredentials({ refresh_token: integration.refresh_token })

  let people
  try {
    people = await fetchAllConnections(oauth)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Google API error'
    // Common case: refresh token revoked → user must reconnect.
    const looksRevoked = /invalid_grant|unauthorized|401/i.test(message)
    return apiError(
      looksRevoked ? 401 : 502,
      looksRevoked
        ? 'Google rejected the saved credentials. Reconnect your Google account.'
        : `Google API error: ${message}`,
      undefined,
      looksRevoked ? 'reconnect_required' : 'google_api_error',
    )
  }

  const mapped = people.map(mapPersonToContact)

  // Pull existing contacts for dedup. We need email + the stored
  // google_resource_name (so re-syncs don't create duplicates for
  // contacts without an email).
  const { data: existing, error: existingError } = await service
    .from('contacts')
    .select('id, email, first_name, last_name, phone, company, title, personal_details')
    .eq('user_id', user.id)

  if (existingError) {
    return apiError(
      500,
      existingError.message,
      undefined,
      'contacts_lookup_failed',
    )
  }

  type ExistingRow = {
    id: string
    email: string | null
    first_name: string | null
    last_name: string | null
    phone: string | null
    company: string | null
    title: string | null
    personal_details: Record<string, unknown> | null
  }
  const existingRows = (existing ?? []) as ExistingRow[]

  const byEmail = new Map<string, ExistingRow>()
  const byResourceName = new Map<string, ExistingRow>()
  for (const row of existingRows) {
    if (row.email) byEmail.set(row.email.toLowerCase(), row)
    const rn = row.personal_details?.google_resource_name
    if (typeof rn === 'string' && rn.length > 0) {
      byResourceName.set(rn, row)
    }
  }

  const toInsert: Record<string, unknown>[] = []
  const updates: { id: string; patch: Record<string, unknown> }[] = []
  let skipped = 0

  for (const m of mapped) {
    if (!m.first_name && !m.last_name && !m.email && !m.phone && !m.company) {
      skipped++
      continue
    }
    const match =
      (m.email && byEmail.get(m.email)) ||
      (m.google_resource_name && byResourceName.get(m.google_resource_name)) ||
      null
    if (match) {
      const patch = buildUpdatePatch(match, m)
      if (patch) updates.push({ id: match.id, patch })
      else skipped++
      continue
    }
    toInsert.push({
      user_id: user.id,
      first_name: m.first_name,
      last_name: m.last_name,
      email: m.email,
      phone: m.phone,
      company: m.company,
      title: m.title,
      personal_details: m.personal_details,
      source: 'google_contacts',
    })
  }

  let inserted = 0
  if (toInsert.length > 0) {
    const { data: insertData, error: insertError } = await service
      .from('contacts')
      .insert(toInsert)
      .select('id')
    if (insertError) {
      return apiError(
        500,
        insertError.message,
        { inserted: 0, updated: 0, skipped },
        'insert_failed',
      )
    }
    inserted = insertData?.length ?? 0
  }

  let updated = 0
  // Sequential is fine — one user's contact list is bounded and updates
  // are field-merges that don't conflict with each other.
  for (const u of updates) {
    const { error: updateError } = await service
      .from('contacts')
      .update(u.patch)
      .eq('id', u.id)
      .eq('user_id', user.id)
    if (!updateError) updated++
  }

  await service
    .from('user_integrations')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('provider', GOOGLE_CONTACTS_PROVIDER)

  if (inserted > 0 || updated > 0) {
    void trackImport(user.id, {
      source: 'google_contacts',
      inserted,
      updated,
      skipped,
    })
  }

  const result: SyncResult = {
    inserted,
    updated,
    skipped,
    total_fetched: people.length,
  }
  return NextResponse.json(result)
}

// ----------------------------------------------------------------------------
// DELETE — disconnect Google Contacts for this user
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
    .eq('provider', GOOGLE_CONTACTS_PROVIDER)

  if (error) {
    return apiError(500, error.message, undefined, 'disconnect_failed')
  }

  return NextResponse.json({ ok: true })
}

// ----------------------------------------------------------------------------
// Update-merge helper
// ----------------------------------------------------------------------------
//
// Conservative: only fills fields that are currently null/empty. The user
// might have edited a contact after the first sync — we don't want to
// clobber their edits with whatever Google currently has.
//
// `personal_details` is always merged (non-destructively) so birthdays /
// addresses / photo_url / google_resource_name stay fresh.
//
// Returns null when nothing would change (so the caller can count it as
// "skipped" and skip the network round-trip).
function buildUpdatePatch(
  existing: {
    first_name: string | null
    last_name: string | null
    phone: string | null
    company: string | null
    title: string | null
    personal_details: Record<string, unknown> | null
  },
  incoming: MappedContact,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  if (!existing.first_name && incoming.first_name) {
    patch.first_name = incoming.first_name
  }
  if (!existing.last_name && incoming.last_name) {
    patch.last_name = incoming.last_name
  }
  if (!existing.phone && incoming.phone) patch.phone = incoming.phone
  if (!existing.company && incoming.company) patch.company = incoming.company
  if (!existing.title && incoming.title) patch.title = incoming.title

  const mergedDetails = {
    ...(existing.personal_details ?? {}),
    ...incoming.personal_details,
  }
  const detailsChanged =
    JSON.stringify(mergedDetails) !==
    JSON.stringify(existing.personal_details ?? {})
  if (detailsChanged) patch.personal_details = mergedDetails

  return Object.keys(patch).length > 0 ? patch : null
}
