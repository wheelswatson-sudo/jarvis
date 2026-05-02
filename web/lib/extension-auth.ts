import { createClient as createSupabaseClient, type User } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Standard CORS headers so the Chrome extension's background service worker
// can call /api/extension/* from a chrome-extension:// origin. We use Bearer
// token auth (no cookies) so wildcard origin is safe.
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '86400',
}

export function corsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export function corsJson<T>(body: T, init: ResponseInit = {}): NextResponse {
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return NextResponse.json(body, { ...init, headers })
}

export function corsError(
  status: number,
  message: string,
  code?: string,
): NextResponse {
  return corsJson({ error: message, code }, { status })
}

export async function getExtensionUser(req: Request): Promise<User | null> {
  const auth =
    req.headers.get('authorization') ?? req.headers.get('Authorization')
  if (!auth) return null
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const token = match[1]?.trim()
  if (!token) return null

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return null

  const supa = createSupabaseClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  try {
    const { data, error } = await supa.auth.getUser(token)
    if (error || !data.user) return null
    return data.user
  } catch {
    return null
  }
}
