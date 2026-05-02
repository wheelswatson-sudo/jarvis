import {
  corsError,
  corsJson,
  corsPreflight,
  getExtensionUser,
} from '../../../../lib/extension-auth'
import { getServiceClient } from '../../../../lib/supabase/service'
import type {
  Contact,
  PersonalDetails,
} from '../../../../lib/types'

export const dynamic = 'force-dynamic'

export function OPTIONS() {
  return corsPreflight()
}

type Source = 'linkedin' | 'facebook'

type ExtractedProfile = {
  source: Source
  url: string
  name: string | null
  headline: string | null
  title: string | null
  company: string | null
  location: string | null
  about: string | null
  profile_photo_url: string | null
  recent_posts: string[]
  current_city: string | null
  workplace: string | null
  life_events: string[]
}

type Body = {
  contact_id?: string
  profile?: ExtractedProfile
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export async function POST(req: Request) {
  const user = await getExtensionUser(req)
  if (!user) return corsError(401, 'Unauthorized', 'unauthorized')

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return corsError(400, 'Invalid JSON', 'bad_request')
  }

  const contactId = body.contact_id
  const profile = body.profile
  if (!contactId || !profile) {
    return corsError(400, 'contact_id and profile required', 'bad_request')
  }
  if (profile.source !== 'linkedin' && profile.source !== 'facebook') {
    return corsError(400, 'Unknown source', 'bad_request')
  }

  const svc = getServiceClient()
  if (!svc) return corsError(500, 'Service client unavailable', 'no_service')

  const { data: contactRow, error: getErr } = await svc
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (getErr) return corsError(500, getErr.message, 'query_failed')
  if (!contactRow) return corsError(404, 'Contact not found', 'not_found')
  const contact = contactRow as Contact

  const pd: PersonalDetails = (contact.personal_details ?? {}) as PersonalDetails
  const next: PersonalDetails = { ...pd }
  const updates: Record<string, unknown> = {}
  const detectedChanges: { field: string; old: string | null; new: string }[] = []

  if (profile.source === 'linkedin') {
    next.linkedin_url = profile.url
    if (isString(profile.headline)) next.linkedin_headline = profile.headline
    if (isString(profile.about)) next.linkedin_about = profile.about
    // Promote LinkedIn URL into the legacy contact.linkedin column if empty,
    // so existing tools that read it benefit from the new data.
    if (!contact.linkedin) updates.linkedin = profile.url

    const newTitle = profile.title ?? profile.headline?.split(' at ')[0] ?? null
    if (isString(newTitle) && newTitle !== contact.title) {
      detectedChanges.push({
        field: 'title',
        old: contact.title,
        new: newTitle,
      })
      if (!contact.title) updates.title = newTitle
    }
    if (isString(profile.company) && profile.company !== contact.company) {
      detectedChanges.push({
        field: 'company',
        old: contact.company,
        new: profile.company,
      })
      if (!contact.company) updates.company = profile.company
    }
  } else {
    next.facebook_url = profile.url
    if (isString(profile.current_city)) {
      next.facebook_current_city = profile.current_city
    }
    if (isString(profile.workplace)) next.facebook_workplace = profile.workplace
    if (profile.life_events.length > 0) {
      const existing = next.life_events ?? []
      const known = new Set(existing.map((e) => e.event))
      const merged = [...existing]
      for (const ev of profile.life_events) {
        if (!known.has(ev)) merged.push({ event: ev })
      }
      next.life_events = merged
    }
  }

  next.social_last_checked_at = new Date().toISOString()
  updates.personal_details = next
  updates.updated_at = new Date().toISOString()

  const { error: updErr } = await svc
    .from('contacts')
    .update(updates)
    .eq('id', contactId)
    .eq('user_id', user.id)
  if (updErr) return corsError(500, updErr.message, 'update_failed')

  // Log a lightweight interaction so the relationship signal updates.
  const summaryBits: string[] = [
    `${profile.source === 'linkedin' ? 'LinkedIn' : 'Facebook'} profile reviewed`,
  ]
  if (detectedChanges.length > 0) {
    summaryBits.push(
      `Detected: ${detectedChanges.map((c) => `${c.field} ${c.old ?? '∅'} → ${c.new}`).join('; ')}`,
    )
  }
  void svc.from('interactions').insert({
    user_id: user.id,
    contact_id: contactId,
    channel: profile.source,
    direction: 'outbound',
    type: 'other',
    summary: summaryBits.join(' · '),
    body: profile.about ?? profile.headline ?? null,
    source: 'chrome-extension',
    occurred_at: new Date().toISOString(),
  })

  // Stage detected changes for human approval rather than auto-overwriting.
  if (detectedChanges.length > 0) {
    const rows = detectedChanges.map((c) => ({
      user_id: user.id,
      contact_id: contactId,
      source: 'chrome-extension',
      field_name: c.field,
      old_value: c.old,
      new_value: c.new,
      status: 'pending' as const,
    }))
    void svc.from('pending_changes').insert(rows)
  }

  return corsJson({ updated: true })
}
