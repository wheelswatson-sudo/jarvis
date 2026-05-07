import {
  corsError,
  corsJson,
  corsPreflight,
  getExtensionUser,
} from '../../../../lib/extension-auth'

export const dynamic = 'force-dynamic'

export function OPTIONS(req: Request) {
  return corsPreflight(req)
}

export async function GET(req: Request) {
  const user = await getExtensionUser(req)
  if (!user) return corsError(req, 401, 'Unauthorized', 'unauthorized')
  return corsJson(req, { ok: true, user: user.email ?? user.id })
}
