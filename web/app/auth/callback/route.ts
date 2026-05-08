import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '../../../lib/supabase/server'
import { GOOGLE_OAUTH_SCOPES } from '../../../lib/google/scopes'
import { persistGoogleTokens } from '../../../lib/google/oauth'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/home'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`,
    )
  }

  // Capture the Google provider tokens out of the freshly-exchanged
  // session — Supabase emits provider_token + provider_refresh_token
  // exactly once, here. We persist them to user_integrations so every
  // subsequent Google API call can refresh silently and the user stays
  // authenticated forever.
  const session = data.session
  const providerToken = session?.provider_token ?? null
  const providerRefreshToken = session?.provider_refresh_token ?? null

  if (session?.user && (providerToken || providerRefreshToken)) {
    try {
      await persistGoogleTokens({
        userId: session.user.id,
        accessToken: providerToken,
        refreshToken: providerRefreshToken,
        scopes: GOOGLE_OAUTH_SCOPES,
        accountEmail: session.user.email ?? null,
      })
    } catch (err) {
      // Don't break the redirect on token-store hiccups — the user can
      // still browse the app; their next API call will surface a
      // reconnect_required error if persistence really failed.
      console.warn('[auth/callback] persistGoogleTokens failed', err)
    }
  }

  return NextResponse.redirect(`${origin}${next}`)
}
