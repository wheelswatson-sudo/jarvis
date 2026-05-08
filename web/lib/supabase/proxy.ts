import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Exact-match public paths. `/` is the marketing landing page — must be
// shareable without auth, and `startsWith('/')` would match everything.
const PUBLIC_EXACT_PATHS = new Set<string>(['/'])

const PUBLIC_PATHS = [
  '/login',
  '/auth',
  '/api/health',
  '/api/intelligence/health',
  // Cron-callable: route handler enforces auth via x-cron-secret OR user
  // session, so the proxy redirect would just block legitimate cron calls.
  '/api/intelligence/analyze',
  // Chrome extension calls authenticate via Authorization: Bearer <token>,
  // not session cookies — the proxy redirect would otherwise turn legitimate
  // calls into a 307 → /login.
  '/api/extension',
  // Local iMessage bridge (bin/jarvis-imessage-bridge) authenticates via
  // Authorization: Bearer + body.user_id — same reason as analyze above.
  // Pinned to the exact path so future /api/imessage/* routes don't
  // inherit the bypass by accident.
  '/api/imessage/sync',
]

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // Malformed/expired auth cookies can cause getUser() to throw. Treat any
  // failure as "no user" so the unauthenticated branch redirects to /login
  // instead of bubbling up as a 500.
  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'] =
    null
  try {
    const result = await supabase.auth.getUser()
    user = result.data.user
  } catch {
    user = null
  }

  const { pathname } = request.nextUrl
  const isPublic =
    PUBLIC_EXACT_PATHS.has(pathname) ||
    PUBLIC_PATHS.some((p) => pathname.startsWith(p))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/home'
    return NextResponse.redirect(url)
  }

  return response
}
