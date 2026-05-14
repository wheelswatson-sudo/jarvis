// Best-effort auto-enrichment for newly-imported contacts.
//
// Hooked into the contact import paths so freshly-inserted rows get an
// opportunistic Apollo /people/match call. Bounded by:
//   - MAX_AUTO_ENRICH per call (matches /api/contacts/enrich's batch cap)
//   - shouldAutoEnrich policy (per-contact eligibility — Watson's decision)
//   - Apollo's own rate limit (we abandon the rest on 429, no error to caller)
//
// Failure modes (no key, auth reject, rate limit, no match, update error) all
// degrade silently — the import response is what matters, enrichment is a
// nice-to-have layered on top.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  APOLLO_PROVIDER,
  ApolloAuthError,
  ApolloRateLimitError,
  buildEnrichmentPatch,
  matchPerson,
} from '../apollo'

export const MAX_AUTO_ENRICH = 10

export type ImportSource = 'manual' | 'vcf' | 'google'

export type AutoEnrichInput = {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
  title: string | null
  phone: string | null
  tier: number | null
  personal_details: Record<string, unknown> | null
}

export type AutoEnrichSummary = {
  attempted: number
  enriched: number
  skipped: number
  errors: number
  rate_limited: boolean
  not_connected: boolean
}

// ---------------------------------------------------------------------------
// shouldAutoEnrich — pure decision: is this freshly-imported contact worth
// spending an Apollo credit on?
//
// TODO(@watson): tune this policy. Trade-offs to weigh:
//   - Cost: every `true` = ~1 Apollo credit. Bulk imports rack up fast.
//   - Match quality: Apollo matches best on email OR name+company. Anything
//     thinner is mostly a wasted credit.
//   - Source intent: 'manual' = single hand-typed (high intent, small batch),
//     'vcf' = full phonebook dump (mixed quality, includes plumbers + exes),
//     'google' = recurring sync (the most acquaintance noise; v1 skips this).
//   - Tier: 1/2 means Watson already flagged the contact as worth tracking.
//     Note: vcf/google imports don't currently set tier, so a tier-only policy
//     would skip them entirely — which may or may not be what you want.
//   - Batch size: a 5000-row vCard import where every row is eligible would
//     hit MAX_AUTO_ENRICH (10) anyway, but a stricter policy keeps you from
//     wasting credits on the random first 10 alphabetical names.
//
// Default below returns `false` — auto-enrichment is OFF until you decide.
// ---------------------------------------------------------------------------
export function shouldAutoEnrich(
  contact: AutoEnrichInput,
  context: { batchSize: number; source: ImportSource },
): boolean {
  void context.batchSize
  // Manual import = single hand-typed contact, high intent. Spend the credit
  // whenever Apollo could plausibly match — either an email, or the
  // first+last+company combo their /people/match endpoint accepts.
  if (context.source === 'manual') {
    if (contact.email) return true
    return Boolean(
      contact.first_name && contact.last_name && contact.company,
    )
  }
  // vCard = bulk phonebook dump (plumbers, dentists, exes). Only enrich rows
  // Watson has already tiered as worth tracking — tier defaults to null on
  // vCard import, so this naturally limits cost to rows tagged later.
  if (context.source === 'vcf') {
    return contact.tier === 1 || contact.tier === 2
  }
  // Google sync = recurring background path. Skipped in v1; needs its own
  // delta+cap design before we let it bill on a schedule.
  return false
}

// ---------------------------------------------------------------------------
// getApolloKeyForUser — reads the per-user Apollo credential from
// user_integrations. Requires the service client (RLS hides access_token from
// the user-scoped one).
// ---------------------------------------------------------------------------
export async function getApolloKeyForUser(
  service: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await service
    .from('user_integrations')
    .select('access_token')
    .eq('user_id', userId)
    .eq('provider', APOLLO_PROVIDER)
    .maybeSingle()
  if (error) {
    console.error('[auto-enrich] integration lookup failed', error)
    return null
  }
  const key = data?.access_token
  return typeof key === 'string' && key.length > 0 ? key : null
}

// ---------------------------------------------------------------------------
// autoEnrichInsertedContacts — main orchestrator. Filters via
// shouldAutoEnrich, caps at MAX_AUTO_ENRICH, runs Apollo sequentially, applies
// non-destructive patches. Never throws — returns a summary the caller can
// log or pass through to the import response.
// ---------------------------------------------------------------------------
export async function autoEnrichInsertedContacts(
  service: SupabaseClient,
  userId: string,
  contacts: AutoEnrichInput[],
  source: ImportSource,
): Promise<AutoEnrichSummary> {
  const summary: AutoEnrichSummary = {
    attempted: 0,
    enriched: 0,
    skipped: 0,
    errors: 0,
    rate_limited: false,
    not_connected: false,
  }

  if (contacts.length === 0) return summary

  // Eligibility filter first — cheap, no DB work — so we skip the
  // user_integrations read entirely when no contact is eligible.
  const eligible = contacts
    .filter((c) => shouldAutoEnrich(c, { batchSize: contacts.length, source }))
    .slice(0, MAX_AUTO_ENRICH)
  if (eligible.length === 0) {
    summary.skipped = contacts.length
    return summary
  }

  const apiKey = await getApolloKeyForUser(service, userId)
  if (!apiKey) {
    summary.not_connected = true
    summary.skipped = contacts.length
    return summary
  }

  for (const c of eligible) {
    summary.attempted++

    let person
    try {
      person = await matchPerson(apiKey, {
        email: c.email,
        first_name: c.first_name,
        last_name: c.last_name,
      })
    } catch (err) {
      if (err instanceof ApolloAuthError) {
        // Saved key was rejected — the rest of the batch will all 401, bail.
        console.warn('[auto-enrich] Apollo auth rejected, abandoning batch')
        summary.errors++
        return summary
      }
      if (err instanceof ApolloRateLimitError) {
        summary.rate_limited = true
        return summary
      }
      console.error('[auto-enrich] match call failed', err)
      summary.errors++
      continue
    }

    if (!person) {
      summary.skipped++
      continue
    }

    const { patch } = buildEnrichmentPatch(person, {
      company: c.company,
      title: c.title,
      phone: c.phone,
      personal_details: c.personal_details,
    })
    if (Object.keys(patch).length === 0) {
      summary.skipped++
      continue
    }

    const { error: updateError } = await service
      .from('contacts')
      .update(patch)
      .eq('id', c.id)
      .eq('user_id', userId)
    if (updateError) {
      console.error('[auto-enrich] update failed', { id: c.id, updateError })
      summary.errors++
      continue
    }
    summary.enriched++
  }

  return summary
}
