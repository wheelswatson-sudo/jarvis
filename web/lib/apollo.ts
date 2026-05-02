// Apollo.io People Enrichment helper.
//
// Docs: https://docs.apollo.io/reference/people-enrichment
// Endpoint: POST https://api.apollo.io/api/v1/people/match
// Auth:     X-Api-Key header (account-scoped key from app.apollo.io).
//
// We hit the match endpoint per-contact rather than the bulk endpoint so a
// single bad row doesn't poison the whole batch — Apollo's bulk endpoint
// returns partial results but its rate-limit accounting is the same either way.

export const APOLLO_PROVIDER = 'apollo'
export const APOLLO_MATCH_URL = 'https://api.apollo.io/api/v1/people/match'

export type ApolloMatchInput = {
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  domain?: string | null
}

export type ApolloPerson = {
  id?: string
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  linkedin_url?: string | null
  title?: string | null
  email?: string | null
  headline?: string | null
  photo_url?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  twitter_url?: string | null
  github_url?: string | null
  facebook_url?: string | null
  organization?: {
    id?: string
    name?: string | null
    website_url?: string | null
    primary_domain?: string | null
    industry?: string | null
    estimated_num_employees?: number | null
    linkedin_url?: string | null
  } | null
  phone_numbers?: Array<{
    raw_number?: string | null
    sanitized_number?: string | null
    type?: string | null
  }> | null
  employment_history?: Array<{
    organization_name?: string | null
    title?: string | null
    start_date?: string | null
    end_date?: string | null
    current?: boolean | null
  }> | null
}

export type ApolloMatchResponse = {
  person?: ApolloPerson | null
}

export async function matchPerson(
  apiKey: string,
  input: ApolloMatchInput,
): Promise<ApolloPerson | null> {
  const body: Record<string, unknown> = {
    reveal_personal_emails: false,
    reveal_phone_number: false,
  }
  if (input.email) body.email = input.email
  if (input.first_name) body.first_name = input.first_name
  if (input.last_name) body.last_name = input.last_name
  if (input.domain) body.domain = input.domain

  const res = await fetch(APOLLO_MATCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  })

  if (res.status === 401 || res.status === 403) {
    throw new ApolloAuthError(`Apollo rejected the API key (HTTP ${res.status}).`)
  }
  if (res.status === 429) {
    throw new ApolloRateLimitError('Apollo rate limit hit.')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Apollo error (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }

  const data = (await res.json().catch(() => null)) as ApolloMatchResponse | null
  return data?.person ?? null
}

export class ApolloAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApolloAuthError'
  }
}

export class ApolloRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApolloRateLimitError'
  }
}

// Pull the most useful fields from an Apollo person and translate them into
// patches for our own contacts table. `existing*` lets the caller decide
// whether to overwrite — we default to non-destructive merges (only fill
// fields that were null/empty), to mirror the Google Contacts sync behavior.
export type EnrichmentPatch = {
  patch: Record<string, unknown>
  details: Record<string, unknown>
  matched: boolean
}

export function buildEnrichmentPatch(
  person: ApolloPerson | null,
  existing: {
    company: string | null
    title: string | null
    phone: string | null
    personal_details: Record<string, unknown> | null
  },
): EnrichmentPatch {
  if (!person) {
    return { patch: {}, details: {}, matched: false }
  }

  const patch: Record<string, unknown> = {}

  const apolloCompany = person.organization?.name ?? null
  if (apolloCompany && !existing.company) patch.company = apolloCompany

  if (person.title && !existing.title) patch.title = person.title

  const apolloPhone =
    person.phone_numbers?.find((p) => p.sanitized_number)?.sanitized_number ??
    person.phone_numbers?.find((p) => p.raw_number)?.raw_number ??
    null
  if (apolloPhone && !existing.phone) patch.phone = apolloPhone

  // Build the apollo block inside personal_details. We always write the
  // full apollo blob so re-enrichment refreshes it, but we don't clobber
  // the rest of personal_details.
  const apolloBlock: Record<string, unknown> = {
    enriched_at: new Date().toISOString(),
  }
  if (person.id) apolloBlock.apollo_id = person.id
  if (person.linkedin_url) apolloBlock.linkedin_url = person.linkedin_url
  if (person.twitter_url) apolloBlock.twitter_url = person.twitter_url
  if (person.github_url) apolloBlock.github_url = person.github_url
  if (person.facebook_url) apolloBlock.facebook_url = person.facebook_url
  if (person.headline) apolloBlock.headline = person.headline
  if (person.photo_url) apolloBlock.photo_url = person.photo_url
  if (person.city || person.state || person.country) {
    apolloBlock.location = [person.city, person.state, person.country]
      .filter(Boolean)
      .join(', ')
  }
  if (person.organization) {
    apolloBlock.organization = {
      name: person.organization.name ?? null,
      website: person.organization.website_url ?? null,
      domain: person.organization.primary_domain ?? null,
      industry: person.organization.industry ?? null,
      employees: person.organization.estimated_num_employees ?? null,
      linkedin_url: person.organization.linkedin_url ?? null,
    }
  }
  if (person.employment_history && person.employment_history.length > 0) {
    apolloBlock.employment_history = person.employment_history
      .slice(0, 10)
      .map((e) => ({
        company: e.organization_name ?? null,
        title: e.title ?? null,
        start_date: e.start_date ?? null,
        end_date: e.end_date ?? null,
        current: e.current ?? null,
      }))
  }

  const mergedDetails = {
    ...(existing.personal_details ?? {}),
    apollo: apolloBlock,
  }
  patch.personal_details = mergedDetails

  return { patch, details: apolloBlock, matched: true }
}
