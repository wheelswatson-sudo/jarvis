import { createClient as createSupabaseClient, type User } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Allowed origins for the Chrome extension. Configure via env var as a
// comma-separated list, e.g.:
//   EXTENSION_ALLOWED_ORIGINS="chrome-extension://abc...,chrome-extension://dev..."
// We deliberately do NOT default to '*' — wildcard CORS lets any site on the
// internet call /api/extension/* with a stolen bearer token. If the env var is
// unset, we fall back to localhost dev and the Vercel preview origin so a
// freshly cloned dev environment still works.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://relationship-intelligence-blue.vercel.app',
]

function getAllowedOrigins(): string[] {
  const raw = process.env.EXTENSION_ALLOWED_ORIGINS
  if (!raw) return DEFAULT_ALLOWED_ORIGINS
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  const list = getAllowedOrigins()
  // Exact match for HTTPS origins. For chrome-extension://, allow either an
  // exact match or the bare scheme `chrome-extension://*` token to mean
  // "any extension" — only useful in dev where the unpacked extension's id
  // changes per machine.
  if (list.includes(origin)) return true
  if (origin.startsWith('chrome-extension://') && list.includes('chrome-extension://*')) {
    return true
  }
  return false
}

const STATIC_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
}

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  const headers: Record<string, string> = { ...STATIC_CORS_HEADERS }
  if (isAllowedOrigin(origin)) {
    // Echo the matched origin (CORS requires either an exact origin or '*';
    // since we use bearer tokens we want the exact origin, never wildcard).
    headers['Access-Control-Allow-Origin'] = origin as string
  }
  // If the origin isn't allowed we omit Allow-Origin entirely so the browser
  // blocks the response. Same-origin and CLI callers (no Origin header) are
  // unaffected.
  return headers
}

export function corsPreflight(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeadersFor(req) })
}

export function corsJson<T>(
  req: Request,
  body: T,
  init: ResponseInit = {},
): NextResponse {
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(corsHeadersFor(req))) headers.set(k, v)
  return NextResponse.json(body, { ...init, headers })
}

export function corsError(
  req: Request,
  status: number,
  message: string,
  code?: string,
): NextResponse {
  return corsJson(req, { error: message, code }, { status })
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
