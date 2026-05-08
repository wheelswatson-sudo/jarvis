// Pulls Google Contacts (People API) for a user and merges them into the
// `contacts` table. Owned by both the on-demand sync route and the auto-sync
// fan-out, so the logic lives here rather than inside an API route — same
// shape as gmail-sync / calendar-sync / tasks-sync.
//
// Mapping is conservative: only fills fields the user hasn't already
// populated, and stashes the rest under personal_details so nothing is
// lost. Dedup is by email first, then by stored google_resource_name so
// re-syncs of email-less contacts don't create duplicates.

import type { SupabaseClient } from '@supabase/supabase-js'
import { trackImport } from '../events'
import {
  GOOGLE_CONTACTS_PROVIDER,
  buildPeopleClientFromAccessToken,
  fetchAllConnections,
  getConnectedAccountEmail,
  mapPersonToContact,
  type MappedContact,
} from './contacts'

export type GoogleContactsSyncSuccess = {
  inserted: number
  updated: number
  skipped: number
  total_fetched: number
  account_email: string | null
}

export type GoogleContactsSyncFailure = {
  code:
    | 'people_api_disabled'
    | 'reconnect_required'
    | 'google_api_error'
    | 'contacts_lookup_failed'
    | 'insert_failed'
  message: string
  status: number
  partial?: { inserted: number; updated: number; skipped: number }
}

export type GoogleContactsSyncOutcome =
  | { ok: true; result: GoogleContactsSyncSuccess }
  | { ok: false; error: GoogleContactsSyncFailure }

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

export async function syncGoogleContactsForUser(
  service: SupabaseClient,
  userId: string,
  accessToken: string,
): Promise<GoogleContactsSyncOutcome> {
  const oauth = buildPeopleClientFromAccessToken(accessToken)

  let people
  try {
    people = await fetchAllConnections(oauth)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Google API error'
    if (
      /SERVICE_DISABLED|API has not been used|People API|accessNotConfigured/i.test(
        message,
      )
    ) {
      return {
        ok: false,
        error: {
          code: 'people_api_disabled',
          status: 503,
          message:
            'Google People API is not enabled on this project. Enable it in Google Cloud Console and retry.',
        },
      }
    }
    const looksAuthFailure = /invalid_grant|unauthorized|401/i.test(message)
    return {
      ok: false,
      error: {
        code: looksAuthFailure ? 'reconnect_required' : 'google_api_error',
        status: looksAuthFailure ? 401 : 502,
        message: looksAuthFailure
          ? 'Google rejected the access token. Sign out and back in with Google.'
          : `Google API error: ${message}`,
      },
    }
  }

  const accountEmail = await getConnectedAccountEmail(oauth)
  const mapped = people.map(mapPersonToContact)

  const { data: existing, error: existingError } = await service
    .from('contacts')
    .select('id, email, first_name, last_name, phone, company, title, personal_details')
    .eq('user_id', userId)

  if (existingError) {
    console.error('[contacts-sync] existing lookup failed', existingError)
    return {
      ok: false,
      error: {
        code: 'contacts_lookup_failed',
        status: 500,
        message: 'Failed to load existing contacts',
      },
    }
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
      user_id: userId,
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
      console.error('[contacts-sync] insert failed', insertError)
      return {
        ok: false,
        error: {
          code: 'insert_failed',
          status: 500,
          message: 'Failed to import contacts',
          partial: { inserted: 0, updated: 0, skipped },
        },
      }
    }
    inserted = insertData?.length ?? 0
  }

  let updated = 0
  for (const u of updates) {
    const { error: updateError } = await service
      .from('contacts')
      .update(u.patch)
      .eq('id', u.id)
      .eq('user_id', userId)
    if (!updateError) updated++
  }

  await service.from('user_integrations').upsert(
    {
      user_id: userId,
      provider: GOOGLE_CONTACTS_PROVIDER,
      account_email: accountEmail,
      last_synced_at: new Date().toISOString(),
      scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
    },
    { onConflict: 'user_id,provider' },
  )

  if (inserted > 0 || updated > 0) {
    void trackImport(userId, {
      source: 'google_contacts',
      inserted,
      updated,
      skipped,
    })
  }

  return {
    ok: true,
    result: {
      inserted,
      updated,
      skipped,
      total_fetched: people.length,
      account_email: accountEmail,
    },
  }
}

// Conservative merge: only fills fields the user hasn't already populated,
// so manual edits aren't clobbered by Google data. `personal_details` is
// always merged non-destructively. Returns null when nothing would change.
function buildUpdatePatch(
  existing: ExistingRow,
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
