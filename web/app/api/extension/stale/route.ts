import {
  corsError,
  corsJson,
  corsPreflight,
  getExtensionUser,
} from '../../../../lib/extension-auth'
import { getServiceClient } from '../../../../lib/supabase/service'
import type { Contact, PersonalDetails } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

export function OPTIONS(req: Request) {
  return corsPreflight(req)
}

const STALE_DAYS = 30

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86_400_000)
}

export async function GET(req: Request) {
  const user = await getExtensionUser(req)
  if (!user) return corsError(req,401, 'Unauthorized', 'unauthorized')

  const svc = getServiceClient()
  if (!svc) return corsError(req,500, 'Service client unavailable', 'no_service')

  const { data, error } = await svc
    .from('contacts')
    .select(
      'id, first_name, last_name, last_interaction_at, linkedin, personal_details, relationship_score, tier',
    )
    .eq('user_id', user.id)
  if (error) {
    console.error('[extension/stale] query failed', error)
    return corsError(req, 500, 'Query failed', 'query_failed')
  }

  const rows = (data ?? []) as Pick<
    Contact,
    | 'id'
    | 'first_name'
    | 'last_name'
    | 'last_interaction_at'
    | 'linkedin'
    | 'personal_details'
    | 'relationship_score'
    | 'tier'
  >[]

  const out = rows
    .map((c) => {
      const pd = (c.personal_details ?? {}) as PersonalDetails
      const linkedinUrl = pd.linkedin_url ?? c.linkedin ?? null
      const facebookUrl = pd.facebook_url ?? null
      const social_url = linkedinUrl ?? facebookUrl
      const source: 'linkedin' | 'facebook' = linkedinUrl ? 'linkedin' : 'facebook'
      if (!social_url) return null
      const days = daysSince(c.last_interaction_at)
      if (days != null && days < STALE_DAYS) return null
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
      return {
        id: c.id,
        name,
        days_since: days,
        social_url,
        source,
        score: c.relationship_score ?? 0,
        tier: c.tier ?? 99,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => {
      // Tier ascending (1 = closest), then days_since descending (most stale first)
      if (a.tier !== b.tier) return a.tier - b.tier
      const da = a.days_since ?? Number.POSITIVE_INFINITY
      const db = b.days_since ?? Number.POSITIVE_INFINITY
      return db - da
    })
    .slice(0, 25)
    .map(({ id, name, days_since, social_url, source }) => ({
      id,
      name,
      days_since,
      social_url,
      source,
    }))

  return corsJson(req, { contacts: out })
}
