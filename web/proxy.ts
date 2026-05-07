import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/proxy'

// Paths that must never be auth-gated by the proxy. Bypass updateSession
// entirely so a Supabase outage / cookie failure can't take these down —
// these are exactly the endpoints uptime monitors hit.
const PROXY_BYPASS_PREFIXES = [
  '/api/health',
  '/api/intelligence/health',
]

// Security headers applied to every response. Kept conservative on CSP so we
// don't break Next's hydration scripts or Tailwind's inline styles; tightening
// to nonce-based requires wiring through every <script>/<style>.
const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    // Next.js needs unsafe-inline for hydration; unsafe-eval is required by
    // some bundler features. Tightening these requires nonce wiring.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // Supabase (REST + realtime) and Sentry — both used at runtime from the
    // browser bundle.
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.sentry.io https://*.ingest.sentry.io",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
}

function applySecurityHeaders(response: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(k)) response.headers.set(k, v)
  }
  return response
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (PROXY_BYPASS_PREFIXES.some((p) => pathname.startsWith(p))) {
    return applySecurityHeaders(NextResponse.next())
  }
  const sessionResponse = await updateSession(request)
  return applySecurityHeaders(sessionResponse)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
