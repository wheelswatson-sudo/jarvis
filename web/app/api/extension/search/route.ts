import {
  corsError,
  corsJson,
  corsPreflight,
  getExtensionUser,
} from '../../../../lib/extension-auth'
import { getServiceClient } from '../../../../lib/supabase/service'
import type { Contact } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

export function OPTIONS(req: Request) {
  return corsPreflight(req)
}

export async function GET(req: Request) {
  const user = await getExtensionUser(req)
  if (!user) return corsError(req, 401, 'Unauthorized', 'unauthorized')

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim()
  if (!q || q.length < 2) {
    return corsJson(req, { contacts: [] })
  }

  const svc = getServiceClient()
  if (!svc) return corsError(req, 500, 'Service client unavailable', 'no_service')

  const escaped = q.replace(/[%_]/g, (c) => `\\${c}`)
  const pattern = `%${escaped}%`

  const { data, error } = await svc
    .from('contacts')
    .select('id, first_name, last_name, company, title, linkedin, personal_details')
    .eq('user_id', user.id)
    .or(
      `first_name.ilike.${pattern},last_name.ilike.${pattern},company.ilike.${pattern},title.ilike.${pattern}`,
    )
    .order('last_name', { ascending: true })
    .order('first_name', { ascending: true })
    .limit(15)
  if (error) return corsError(req, 500, error.message, 'query_failed')

  const contacts = ((data ?? []) as Pick<
    Contact,
    | 'id'
    | 'first_name'
    | 'last_name'
    | 'company'
    | 'title'
    | 'linkedin'
    | 'personal_details'
  >[]).map((c) => ({
    id: c.id,
    name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim(),
    company: c.company,
    title: c.title,
    linkedin: c.linkedin,
    personal_details: c.personal_details ?? null,
  }))

  return corsJson(req, { contacts })
}
