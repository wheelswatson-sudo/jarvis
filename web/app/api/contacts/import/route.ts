import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'
import { trackImport } from '../../../../lib/events'
import {
  autoEnrichInsertedContacts,
  type AutoEnrichInput,
} from '../../../../lib/contacts/auto-enrich'

export const dynamic = 'force-dynamic'

const MAX_BATCH = 5000
const TIER_VALUES = new Set([1, 2, 3])

type Incoming = {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  company?: string | null
  title?: string | null
  notes?: string | null
  tier?: number | null
  tags?: string[] | null
  linkedin_url?: string | null
}

type RowResult = { row: number; error: string }

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function normalizeTier(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return null
  const rounded = Math.trunc(n)
  return TIER_VALUES.has(rounded) ? rounded : null
}

function normalizeTags(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const arr = value
      .map((t) => clean(t))
      .filter((t): t is string => t !== null)
    return arr.length === 0 ? null : arr
  }
  const str = clean(value)
  if (!str) return null
  const parts = str
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length === 0 ? null : parts
}

function normalizeLinkedin(value: unknown): string | null {
  const s = clean(value)
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('linkedin.com') || s.startsWith('www.linkedin.com')) {
    return `https://${s}`
  }
  if (s.startsWith('/in/') || s.startsWith('in/')) {
    return `https://www.linkedin.com/${s.replace(/^\//, '')}`
  }
  return s
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return apiError(400, 'Invalid JSON', undefined, 'invalid_json')
  }

  const rawContacts = (body as { contacts?: unknown })?.contacts
  if (!Array.isArray(rawContacts)) {
    return apiError(
      400,
      'contacts must be an array',
      undefined,
      'contacts_must_be_array',
    )
  }
  if (rawContacts.length === 0) {
    return apiError(
      400,
      'No contacts provided',
      undefined,
      'no_contacts_provided',
    )
  }
  if (rawContacts.length > MAX_BATCH) {
    return apiError(
      400,
      `Too many contacts (max ${MAX_BATCH})`,
      { max: MAX_BATCH },
      'too_many_contacts',
    )
  }

  const rows: Record<string, unknown>[] = []
  const skipped: RowResult[] = []

  rawContacts.forEach((raw, idx) => {
    const row = idx + 1
    if (!raw || typeof raw !== 'object') {
      skipped.push({ row, error: 'row is not an object' })
      return
    }
    const c = raw as Incoming
    const first = clean(c.first_name)
    const last = clean(c.last_name)
    // Lowercase emails on insert so downstream sync paths (Gmail, Calendar)
    // can match by lowercase without a case-insensitive query. The Google
    // Contacts importer already does this — keep imports consistent.
    const email = clean(c.email)?.toLowerCase() ?? null
    const phone = clean(c.phone)
    const company = clean(c.company)
    const title = clean(c.title)
    const notes = clean(c.notes)
    const linkedin = normalizeLinkedin(c.linkedin_url)
    const tier = normalizeTier(c.tier)
    const tags = normalizeTags(c.tags)

    if (!first && !last && !email && !phone && !company) {
      skipped.push({ row, error: 'row is empty' })
      return
    }

    rows.push({
      user_id: user.id,
      first_name: first,
      last_name: last,
      email,
      phone,
      company,
      title,
      notes,
      tier,
      tags,
      linkedin,
    })
  })

  if (rows.length === 0) {
    return NextResponse.json({
      inserted: 0,
      skipped: skipped.length,
      errors: skipped,
    })
  }

  const { data, error } = await supabase
    .from('contacts')
    .insert(rows)
    .select(
      'id, first_name, last_name, email, company, title, phone, tier, personal_details',
    )

  if (error) {
    console.error('[contacts/import] insert failed', error)
    return apiError(
      500,
      'Failed to import contacts',
      { inserted: 0, skipped: skipped.length, errors: skipped },
      'insert_failed',
    )
  }

  const insertedCount = data?.length ?? 0
  if (insertedCount > 0) {
    void trackImport(user.id, {
      inserted: insertedCount,
      skipped: skipped.length,
    })
  }

  const service = getServiceClient()
  const enrichment = service
    ? await autoEnrichInsertedContacts(
        service,
        user.id,
        (data ?? []) as AutoEnrichInput[],
        'manual',
      )
    : null

  return NextResponse.json({
    inserted: insertedCount,
    skipped: skipped.length,
    errors: skipped,
    enrichment,
  })
}
