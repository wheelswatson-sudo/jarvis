import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import {
  autoEnrichInsertedContacts,
  type AutoEnrichInput,
} from '../../../../lib/contacts/auto-enrich'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Accepts a JSON array of contacts parsed from a VCF file.
// Each contact: { first_name, last_name, email, phone, company, title, birthday, notes }
// Upserts by email (case-insensitive) to avoid duplicates with existing contacts.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const service = getServiceClient()
  if (!service) {
    return apiError(500, 'Service role key not configured.', undefined, 'service_unavailable')
  }

  const body = await req.json().catch(() => null)
  if (!body?.contacts || !Array.isArray(body.contacts)) {
    return apiError(400, 'Missing contacts array in body.', undefined, 'bad_request')
  }

  const contacts = body.contacts as Array<{
    first_name?: string
    last_name?: string
    email?: string
    phone?: string
    company?: string
    title?: string
    birthday?: string
    notes?: string
  }>

  // Fetch existing contacts for dedup
  const { data: existing, error: existingError } = await service
    .from('contacts')
    .select('id, email, first_name, last_name, phone, company, title, personal_details')
    .eq('user_id', user.id)

  if (existingError) {
    console.error('[contacts/import-vcf] existing lookup failed', existingError)
    return apiError(500, 'Failed to load existing contacts', undefined, 'contacts_lookup_failed')
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
  for (const row of existingRows) {
    if (row.email) byEmail.set(row.email.toLowerCase(), row)
  }

  const toInsert: Record<string, unknown>[] = []
  const updates: { id: string; patch: Record<string, unknown> }[] = []
  let skipped = 0

  for (const c of contacts) {
    if (!c.first_name && !c.last_name) {
      skipped++
      continue
    }

    const personalDetails: Record<string, unknown> = {}
    if (c.birthday) personalDetails.birthday = c.birthday
    if (c.notes) personalDetails.notes = c.notes
    personalDetails.import_source = 'apple_contacts'

    const match = c.email ? byEmail.get(c.email.toLowerCase()) : null
    if (match) {
      // Merge — only fill empty fields
      const patch: Record<string, unknown> = {}
      if (!match.first_name && c.first_name) patch.first_name = c.first_name
      if (!match.last_name && c.last_name) patch.last_name = c.last_name
      if (!match.phone && c.phone) patch.phone = c.phone
      if (!match.company && c.company) patch.company = c.company
      if (!match.title && c.title) patch.title = c.title
      const mergedDetails = { ...(match.personal_details ?? {}), ...personalDetails }
      if (JSON.stringify(mergedDetails) !== JSON.stringify(match.personal_details ?? {})) {
        patch.personal_details = mergedDetails
      }
      if (Object.keys(patch).length > 0) {
        updates.push({ id: match.id, patch })
      } else {
        skipped++
      }
      continue
    }

    toInsert.push({
      user_id: user.id,
      first_name: c.first_name || null,
      last_name: c.last_name || null,
      email: c.email ? c.email.toLowerCase() : null,
      phone: c.phone || null,
      company: c.company || null,
      title: c.title || null,
      personal_details: personalDetails,
    })
  }

  let inserted = 0
  const insertedRows: AutoEnrichInput[] = []
  // Batch inserts in chunks of 100
  for (let i = 0; i < toInsert.length; i += 100) {
    const chunk = toInsert.slice(i, i + 100)
    const { data: insertData, error: insertError } = await service
      .from('contacts')
      .insert(chunk)
      .select(
        'id, first_name, last_name, email, company, title, phone, tier, personal_details',
      )
    if (insertError) {
      console.error('[contacts/import-vcf] insert chunk failed', insertError)
      return apiError(
        500,
        'Failed to import contacts',
        { inserted, updated: 0, skipped, at_chunk: i },
        'insert_failed',
      )
    }
    inserted += insertData?.length ?? 0
    if (insertData) insertedRows.push(...(insertData as AutoEnrichInput[]))
  }

  let updated = 0
  for (const u of updates) {
    const { error: updateError } = await service
      .from('contacts')
      .update(u.patch)
      .eq('id', u.id)
      .eq('user_id', user.id)
    if (!updateError) updated++
  }

  const enrichment = await autoEnrichInsertedContacts(
    service,
    user.id,
    insertedRows,
    'vcf',
  )

  return NextResponse.json({
    inserted,
    updated,
    skipped,
    total_received: contacts.length,
    enrichment,
  })
}
