import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/proxy'

// Paths that must never be auth-gated by the proxy. Bypass updateSession
// entirely so a Supabase outage / cookie failure can't take these down —
// these are exactly the endpoints uptime monitors hit.
const PROXY_BYPASS_PREFIXES = [
  '/api/health',
  '/api/intelligence/health',
]

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (PROXY_BYPASS_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }
  return updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
