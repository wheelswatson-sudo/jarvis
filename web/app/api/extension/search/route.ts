import {
  corsError,
  corsJson,
  corsPreflight,
  getExtensionUser,
} from '../../../../lib/extension-auth'
import { getServiceClient } from '../../../../lib/supabase/service'
import type { Contact } from '../../../../lib/types'

export const dynamic = 'force-dynamic'

export function OPTIONS() {
  return corsPreflight()
}

export async function GET(req: Request) {
  const user = await getExtensionUser(req)
  if (!user) return corsError(401, 'Unauthorized', 'unauthorized')

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim()
  if (!q || q.length < 2) {
    return corsJson({ contacts: [] })
  }

  const svc = getServiceClient()
  if (!svc) return corsError(500, 'Service client unavailable', 'no_service')

  const escaped = q.replace(/[%_]/g, (c) => `\\${c}`)
  const pattern = `%${escaped}%`

  const { data, error } = await svc
    .from('contacts')
    .select('id, name, company, title, linkedin, personal_details')
    .eq('user_id', user.id)
    .or(
      `name.ilike.${pattern},company.ilike.${pattern},title.ilike.${pattern}`,
    )
    .order('name', { ascending: true })
    .limit(15)
  if (error) return corsError(500, error.message, 'query_failed')

  const contacts = ((data ?? []) as Pick<
    Contact,
    'id' | 'name' | 'company' | 'title' | 'linkedin' | 'personal_details'
  >[]).map((c) => ({
    id: c.id,
    name: c.name,
    company: c.company,
    title: c.title,
    linkedin: c.linkedin,
    personal_details: c.personal_details ?? null,
  }))

  return corsJson({ contacts })
}
