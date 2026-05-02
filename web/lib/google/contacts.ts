// Google Contacts (People API) integration helpers.
//
// We piggy-back on the Google access token already minted during the
// Supabase login flow (the `contacts.readonly` scope is requested at
// sign-in), so there's no separate OAuth dance for this integration.
// The route receives the access token from the client (read out of the
// Supabase session) and we build a bare OAuth2 client around it.
//
// Mapping is conservative: we only fill fields the user hasn't already
// populated, and we stash everything else (birthday, addresses, photo,
// the Google resourceName) under personal_details so nothing is lost.

import { google, type people_v1, type Auth } from 'googleapis'

type OAuth2Client = Auth.OAuth2Client

export const GOOGLE_CONTACTS_PROVIDER = 'google_contacts'

export const PEOPLE_API_PERSON_FIELDS =
  'names,emailAddresses,phoneNumbers,organizations,birthdays,photos,addresses'

export function buildPeopleClientFromAccessToken(
  accessToken: string,
): OAuth2Client {
  const client = new google.auth.OAuth2()
  client.setCredentials({ access_token: accessToken })
  return client
}

export async function getConnectedAccountEmail(
  client: OAuth2Client,
): Promise<string | null> {
  // The People API exposes the authenticated user's own profile under
  // people/me. Pulling email here lets us record *which* Google account
  // sourced the contacts.
  try {
    const people = google.people({ version: 'v1', auth: client })
    const res = await people.people.get({
      resourceName: 'people/me',
      personFields: 'emailAddresses',
    })
    const primary =
      res.data.emailAddresses?.find((e) => e.metadata?.primary) ??
      res.data.emailAddresses?.[0]
    return primary?.value ?? null
  } catch {
    return null
  }
}

export type MappedContact = {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  company: string | null
  title: string | null
  personal_details: Record<string, unknown>
  google_resource_name: string | null
}

function pickPrimary<T extends { metadata?: { primary?: boolean | null } | null }>(
  arr: T[] | undefined | null,
): T | null {
  if (!arr || arr.length === 0) return null
  return arr.find((x) => x.metadata?.primary) ?? arr[0]
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

export function mapPersonToContact(
  person: people_v1.Schema$Person,
): MappedContact {
  const name = pickPrimary(person.names ?? [])
  const email = pickPrimary(person.emailAddresses ?? [])
  const phone = pickPrimary(person.phoneNumbers ?? [])
  const org = pickPrimary(person.organizations ?? [])
  const photo = pickPrimary(person.photos ?? [])

  const birthdays = (person.birthdays ?? [])
    .map((b) => {
      if (b.text) return b.text
      const d = b.date
      if (!d) return null
      const parts = [
        d.year ? String(d.year).padStart(4, '0') : null,
        d.month ? String(d.month).padStart(2, '0') : null,
        d.day ? String(d.day).padStart(2, '0') : null,
      ].filter((p): p is string => p !== null)
      return parts.length > 0 ? parts.join('-') : null
    })
    .filter((b): b is string => b !== null)

  const addresses = (person.addresses ?? [])
    .map((a) => ({
      type: nonEmpty(a.type),
      formatted: nonEmpty(a.formattedValue),
      street: nonEmpty(a.streetAddress),
      city: nonEmpty(a.city),
      region: nonEmpty(a.region),
      postal_code: nonEmpty(a.postalCode),
      country: nonEmpty(a.country),
    }))
    .filter((a) => Object.values(a).some((v) => v !== null))

  const personal_details: Record<string, unknown> = {}
  if (birthdays.length > 0) personal_details.birthdays = birthdays
  if (addresses.length > 0) personal_details.addresses = addresses
  if (photo?.url) personal_details.photo_url = photo.url
  if (person.resourceName) {
    personal_details.google_resource_name = person.resourceName
  }

  return {
    first_name: nonEmpty(name?.givenName),
    last_name: nonEmpty(name?.familyName),
    email: nonEmpty(email?.value)?.toLowerCase() ?? null,
    phone: nonEmpty(phone?.value),
    company: nonEmpty(org?.name),
    title: nonEmpty(org?.title),
    personal_details,
    google_resource_name: nonEmpty(person.resourceName),
  }
}

export async function fetchAllConnections(
  client: OAuth2Client,
): Promise<people_v1.Schema$Person[]> {
  const people = google.people({ version: 'v1', auth: client })
  const all: people_v1.Schema$Person[] = []
  let pageToken: string | undefined = undefined
  // Hard cap to keep one sync inside the Vercel serverless time budget.
  // 5000 connections × 1000 page size = at most 5 round-trips.
  const MAX_PAGES = 10
  for (let i = 0; i < MAX_PAGES; i++) {
    const res: { data: people_v1.Schema$ListConnectionsResponse } =
      await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: 1000,
        personFields: PEOPLE_API_PERSON_FIELDS,
        pageToken,
      })
    if (res.data.connections) {
      all.push(...res.data.connections)
    }
    if (!res.data.nextPageToken) break
    pageToken = res.data.nextPageToken
  }
  return all
}
