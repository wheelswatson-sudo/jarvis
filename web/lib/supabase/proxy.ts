import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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
]
const ONBOARDING_ALLOWED = ['/onboarding', '/api/onboarding', '/auth']

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
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  if (user) {
    const inOnboardingFlow = ONBOARDING_ALLOWED.some((p) =>
      pathname.startsWith(p),
    )
    if (!inOnboardingFlow) {
      // Fail-open: if the profiles table doesn't exist or the query errors,
      // don't lock the user out. Only redirect when we can confirm the row
      // exists with a null onboarded_at.
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('onboarded_at')
        .eq('id', user.id)
        .maybeSingle()

      const needsOnboarding =
        !error && (profile === null || profile.onboarded_at === null)

      if (needsOnboarding) {
        const url = request.nextUrl.clone()
        url.pathname = '/onboarding'
        return NextResponse.redirect(url)
      }
    }
  }

  return response
}
