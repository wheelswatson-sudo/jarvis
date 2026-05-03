import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { trackImport } from '../../../../lib/events'
import {
  GOOGLE_CONTACTS_PROVIDER,
  buildPeopleClientFromAccessToken,
  fetchAllConnections,
  getConnectedAccountEmail,
  mapPersonToContact,
  type MappedContact,
} from '../../../../lib/google/contacts'
import { getValidAccessTokenForUser } from '../../../../lib/google/oauth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type SyncResult = {
  inserted: number
  updated: number
  skipped: number
  total_fetched: number
}

// ----------------------------------------------------------------------------
// POST — sync Google Contacts using the access token from the Supabase
// session (granted at login via the contacts.readonly scope).
// ----------------------------------------------------------------------------
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const tok = await getValidAccessTokenForUser(user.id)
  if ('error' in tok) return tok.error
  const accessToken = tok.token

  const service = getServiceClient()
  if (!service) {
    return apiError(
      500,
      'Service role key not configured.',
      undefined,
      'service_unavailable',
    )
  }

  const oauth = buildPeopleClientFromAccessToken(accessToken)

  let people
  try {
    people = await fetchAllConnections(oauth)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Google API error'
    // "SERVICE_DISABLED" / "API has not been used" → People API isn't
    // enabled on the Google Cloud project. Tell the user that directly
    // instead of pretending it's an auth issue.
    if (
      /SERVICE_DISABLED|API has not been used|People API|accessNotConfigured/i.test(
        message,
      )
    ) {
      return apiError(
        503,
        'Google People API is not enabled on this project. Enable it in Google Cloud Console and retry.',
        undefined,
        'people_api_disabled',
      )
    }
    const looksAuthFailure = /invalid_grant|unauthorized|401/i.test(message)
    return apiError(
      looksAuthFailure ? 401 : 502,
      looksAuthFailure
        ? 'Google rejected the access token. Sign out and back in with Google.'
        : `Google API error: ${message}`,
      undefined,
      looksAuthFailure ? 'reconnect_required' : 'google_api_error',
    )
  }

  const accountEmail = await getConnectedAccountEmail(oauth)

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

  // Record the sync time so the UI can surface it. We only need user_id +
  // provider; refresh_token stays null because we don't manage tokens here.
  await service.from('user_integrations').upsert(
    {
      user_id: user.id,
      provider: GOOGLE_CONTACTS_PROVIDER,
      account_email: accountEmail,
      last_synced_at: new Date().toISOString(),
      scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
    },
    { onConflict: 'user_id,provider' },
  )

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
