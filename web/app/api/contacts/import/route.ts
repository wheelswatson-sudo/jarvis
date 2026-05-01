import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'

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
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const rawContacts = (body as { contacts?: unknown })?.contacts
  if (!Array.isArray(rawContacts)) {
    return NextResponse.json(
      { error: 'contacts_must_be_array' },
      { status: 400 },
    )
  }
  if (rawContacts.length === 0) {
    return NextResponse.json(
      { error: 'no_contacts_provided' },
      { status: 400 },
    )
  }
  if (rawContacts.length > MAX_BATCH) {
    return NextResponse.json(
      { error: 'too_many_contacts', max: MAX_BATCH },
      { status: 400 },
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
    const email = clean(c.email)
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
      linkedin_url: linkedin,
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
    .select('id')

  if (error) {
    return NextResponse.json(
      {
        inserted: 0,
        skipped: skipped.length,
        errors: skipped,
        error: error.message,
      },
      { status: 400 },
    )
  }

  return NextResponse.json({
    inserted: data?.length ?? 0,
    skipped: skipped.length,
    errors: skipped,
  })
}
