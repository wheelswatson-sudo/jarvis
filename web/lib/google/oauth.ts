// Shared Google OAuth helpers — scope list, server-side token store, and
// silent-refresh flow.
//
// Auth model:
//   1. Login page calls Supabase signInWithOAuth({ provider: 'google',
//      access_type: 'offline', prompt: 'consent' }). On the FIRST consent
//      Google issues both an access token AND a refresh token.
//   2. /auth/callback exchanges the auth code, then calls
//      `persistGoogleTokens` below to write refresh_token / access_token /
//      access_token_expires_at into user_integrations(provider='google').
//   3. Every API route calls `getValidAccessTokenForUser(userId)`, which
//      hands back the cached access token if it's still valid, or silently
//      refreshes it via Google's oauth2 token endpoint and returns the new
//      one. Users connect once and stay authenticated forever.

import { google, type Auth } from 'googleapis'
import { NextResponse } from 'next/server'
import { apiError } from '../api-errors'
import { getServiceClient } from '../supabase/service'

export { GOOGLE_OAUTH_SCOPES } from './scopes'

export type GoogleOAuth2Client = Auth.OAuth2Client

// Single canonical row that holds the long-lived refresh token. Per-service
// rows (google_gmail / google_calendar / etc.) carry only `last_synced_at`
// for the Settings UI.
export const GOOGLE_AUTH_PROVIDER = 'google'

// 60-second buffer — refresh slightly before the token actually expires so
// we don't race the clock during a long request.
const TOKEN_REFRESH_BUFFER_MS = 60_000

export function buildOAuthClient(accessToken: string): GoogleOAuth2Client {
  const client = new google.auth.OAuth2()
  client.setCredentials({ access_token: accessToken })
  return client
}

export function googleApiError(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : 'Google API error'
  if (
    /SERVICE_DISABLED|API has not been used|accessNotConfigured/i.test(message)
  ) {
    return apiError(
      503,
      `Google API is not enabled on this project: ${message}`,
      undefined,
      'google_api_disabled',
    )
  }
  if (/invalid_grant|unauthorized|401/i.test(message)) {
    return apiError(
      401,
      'Google rejected the access token. Sign out and back in with Google.',
      undefined,
      'reconnect_required',
    )
  }
  return apiError(502, `Google API error: ${message}`, undefined, 'google_api_error')
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

type PersistInput = {
  userId: string
  accessToken: string | null
  refreshToken: string | null
  /** Seconds until the access token expires; defaults to 3500 (Google's standard ~3600s minus a 100s buffer). */
  expiresInSeconds?: number | null
  scopes?: readonly string[]
  accountEmail?: string | null
}

/**
 * Persist tokens to user_integrations(provider='google'). Called from the
 * auth callback right after `exchangeCodeForSession`.
 *
 * Refresh tokens are only emitted by Google on the FIRST consent (or when
 * `prompt=consent` forces re-consent). On subsequent logins Supabase's
 * provider_refresh_token will be null — in that case we keep whatever
 * refresh token is already on file rather than overwriting it with null.
 */
export async function persistGoogleTokens(input: PersistInput): Promise<void> {
  const service = getServiceClient()
  if (!service) return

  const expiresInSec = input.expiresInSeconds ?? 3500
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString()

  const patch: Record<string, unknown> = {
    user_id: input.userId,
    provider: GOOGLE_AUTH_PROVIDER,
    last_synced_at: new Date().toISOString(),
  }
  if (input.accessToken) {
    patch.access_token = input.accessToken
    patch.access_token_expires_at = expiresAt
  }
  if (input.refreshToken) {
    patch.refresh_token = input.refreshToken
  }
  if (input.scopes && input.scopes.length > 0) {
    patch.scopes = [...input.scopes]
  }
  if (input.accountEmail) {
    patch.account_email = input.accountEmail
  }

  // If we don't have a refresh token in this payload we still want to update
  // the access token, but we MUST NOT clobber the existing refresh_token.
  // Postgres upsert with onConflict updates ALL columns of the row by
  // default, so we use a two-step pattern: try update first, fall back to
  // insert if the row doesn't exist yet.
  if (input.refreshToken) {
    await service
      .from('user_integrations')
      .upsert(patch, { onConflict: 'user_id,provider' })
    return
  }

  const { data: existing } = await service
    .from('user_integrations')
    .select('id')
    .eq('user_id', input.userId)
    .eq('provider', GOOGLE_AUTH_PROVIDER)
    .maybeSingle()

  if (existing?.id) {
    await service
      .from('user_integrations')
      .update(patch)
      .eq('id', existing.id)
  } else {
    await service.from('user_integrations').insert(patch)
  }
}

// ---------------------------------------------------------------------------
// Silent refresh
// ---------------------------------------------------------------------------

type StoredTokenRow = {
  access_token: string | null
  refresh_token: string | null
  access_token_expires_at: string | null
  scopes: string[] | null
}

// Three reasons a token lookup can fail. The auto-sync route surfaces each
// to the client differently (silent skip vs. "reconnect Google" toast vs.
// transient error toast), so we discriminate here instead of collapsing
// everything into one opaque `error` envelope. Existing callers that just
// want a NextResponse can still do `if ('error' in tok) return tok.error`.
export type TokenLookupKind = 'not_connected' | 'reconnect_required' | 'transient'

type TokenLookup =
  | { token: string }
  | { error: NextResponse; kind: TokenLookupKind }

/**
 * Returns a valid access token for the user, refreshing it via Google's
 * oauth2 endpoint if the cached one is expired (or about to expire).
 *
 * Caller pattern (NextResponse short-circuit):
 *   const tok = await getValidAccessTokenForUser(user.id)
 *   if ('error' in tok) return tok.error
 *   const client = buildOAuthClient(tok.token)
 *
 * Caller pattern (kind-aware, e.g. auto-sync that wants to distinguish
 * "user never connected" from "user revoked the OAuth grant"):
 *   if ('error' in tok) {
 *     switch (tok.kind) {
 *       case 'not_connected':       // hide UI silently
 *       case 'reconnect_required':  // tell user to reconnect
 *       case 'transient':           // log + soft-fail
 *     }
 *   }
 */
export async function getValidAccessTokenForUser(
  userId: string,
): Promise<TokenLookup> {
  const service = getServiceClient()
  if (!service) {
    return {
      kind: 'transient',
      error: apiError(
        500,
        'Service role key not configured.',
        undefined,
        'service_unavailable',
      ),
    }
  }

  const { data, error } = await service
    .from('user_integrations')
    .select('access_token, refresh_token, access_token_expires_at, scopes')
    .eq('user_id', userId)
    .eq('provider', GOOGLE_AUTH_PROVIDER)
    .maybeSingle()

  if (error) {
    return {
      kind: 'transient',
      error: apiError(
        500,
        `Failed to read Google token: ${error.message}`,
        undefined,
        'token_lookup_failed',
      ),
    }
  }
  const row = data as StoredTokenRow | null
  if (!row || !row.refresh_token) {
    return {
      kind: 'not_connected',
      error: apiError(
        401,
        'Google not connected. Visit Settings to connect your Google account.',
        undefined,
        'not_connected',
      ),
    }
  }

  const expiresAt = row.access_token_expires_at
    ? Date.parse(row.access_token_expires_at)
    : 0
  const stillValid =
    !!row.access_token &&
    Number.isFinite(expiresAt) &&
    expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS

  if (stillValid && row.access_token) {
    return { token: row.access_token }
  }

  // Need to refresh.
  const refreshed = await exchangeRefreshToken(row.refresh_token)
  if ('error' in refreshed) {
    if (refreshed.code === 'invalid_grant') {
      // Refresh token has been revoked / expired — caller should send the
      // user through Reconnect.
      return {
        kind: 'reconnect_required',
        error: apiError(
          401,
          'Google connection has been revoked. Please reconnect Google in Settings.',
          undefined,
          'reconnect_required',
        ),
      }
    }
    return {
      kind: 'transient',
      error: apiError(
        502,
        `Failed to refresh Google access token: ${refreshed.error}`,
        undefined,
        'refresh_failed',
      ),
    }
  }

  const newExpiresAt = new Date(
    Date.now() + refreshed.expiresInSec * 1000,
  ).toISOString()
  await service
    .from('user_integrations')
    .update({
      access_token: refreshed.accessToken,
      access_token_expires_at: newExpiresAt,
    })
    .eq('user_id', userId)
    .eq('provider', GOOGLE_AUTH_PROVIDER)

  return { token: refreshed.accessToken }
}

type RefreshOk = {
  accessToken: string
  expiresInSec: number
}
type RefreshErr = { error: string; code?: string }

async function exchangeRefreshToken(
  refreshToken: string,
): Promise<RefreshOk | RefreshErr> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return {
      error:
        'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured. Add them to the deployment env to enable token refresh.',
    }
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  let res: Response
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      cache: 'no-store',
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'fetch_failed' }
  }

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }

  if (!res.ok || !body.access_token) {
    return {
      error: body.error_description ?? body.error ?? `HTTP ${res.status}`,
      code: body.error,
    }
  }

  return {
    accessToken: body.access_token,
    expiresInSec: typeof body.expires_in === 'number' ? body.expires_in : 3500,
  }
}
