import {
  corsError,
  corsJson,
  corsPreflight,
  getExtensionUser,
} from '../../../../lib/extension-auth'
import { getServiceClient } from '../../../../lib/supabase/service'
import type { Contact, PersonalDetails } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

export function OPTIONS() {
  return corsPreflight()
}

type MatchPayload = {
  match: {
    id: string
    name: string
    company: string | null
    title: string | null
    linkedin: string | null
    personal_details: PersonalDetails | null
  } | null
}

function normalizeLinkedIn(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\/(www\.|m\.)?/, '')
    .replace(/\/+$/, '')
    .replace(/\?.*$/, '')
}

function normalizeFacebook(url: string): string {
  // Strip query params except id (used for profile.php?id=)
  try {
    const u = new URL(url)
    const id = u.searchParams.get('id')
    const path = u.pathname.replace(/\/+$/, '')
    return id
      ? `${u.host}${path}?id=${id}`.replace(/^(www\.|m\.)/, '')
      : `${u.host}${path}`.replace(/^(www\.|m\.)/, '')
  } catch {
    return url.toLowerCase()
  }
}

function detectSource(url: string): 'linkedin' | 'facebook' | null {
  if (/linkedin\.com/i.test(url)) return 'linkedin'
  if (/facebook\.com/i.test(url)) return 'facebook'
  return null
}

export async function GET(req: Request) {
  const user = await getExtensionUser(req)
  if (!user) return corsError(401, 'Unauthorized', 'unauthorized')

  const { searchParams } = new URL(req.url)
  const url = searchParams.get('url')?.trim()
  const name = searchParams.get('name')?.trim() ?? null
  if (!url) return corsError(400, 'url is required', 'bad_request')

  const svc = getServiceClient()
  if (!svc) return corsError(500, 'Service client unavailable', 'no_service')

  const source = detectSource(url)

  // Pull a user-scoped slice of contacts, then match in memory. The candidate
  // set is small (a few hundred at most) so we can afford the simplicity over
  // bespoke JSONB SQL — and it lets us match against contacts.linkedin too.
  const { data, error } = await svc
    .from('contacts')
    .select('id, first_name, last_name, company, title, linkedin, personal_details')
    .eq('user_id', user.id)
  if (error) return corsError(500, error.message, 'query_failed')

  type Row = Pick<
    Contact,
    | 'id'
    | 'first_name'
    | 'last_name'
    | 'company'
    | 'title'
    | 'linkedin'
    | 'personal_details'
  >
  const contacts = (data ?? []) as Row[]
  const composedName = (c: Row): string =>
    [c.first_name, c.last_name].filter(Boolean).join(' ').trim()

  const targetLinkedIn =
    source === 'linkedin' ? normalizeLinkedIn(url) : null
  const targetFacebook =
    source === 'facebook' ? normalizeFacebook(url) : null

  let matched: (typeof contacts)[number] | null = null

  for (const c of contacts) {
    const pd = (c.personal_details ?? {}) as PersonalDetails
    if (targetLinkedIn) {
      const candidates = [c.linkedin, pd.linkedin_url]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .map(normalizeLinkedIn)
      if (candidates.includes(targetLinkedIn)) {
        matched = c
        break
      }
    }
    if (targetFacebook) {
      const fb = pd.facebook_url
      if (fb && normalizeFacebook(fb) === targetFacebook) {
        matched = c
        break
      }
    }
  }

  if (!matched && name) {
    // Fallback to case-insensitive name match. Take the highest-tier candidate
    // if multiple share the same name to avoid logging into a stale dupe.
    const lower = name.toLowerCase()
    const candidates = contacts.filter(
      (c) => composedName(c).toLowerCase() === lower,
    )
    if (candidates.length > 0) {
      matched = candidates[0]!
    }
  }

  const payload: MatchPayload = matched
    ? {
        match: {
          id: matched.id,
          name: composedName(matched),
          company: matched.company,
          title: matched.title,
          linkedin: matched.linkedin,
          personal_details: matched.personal_details ?? null,
        },
      }
    : { match: null }

  return corsJson(payload)
}
