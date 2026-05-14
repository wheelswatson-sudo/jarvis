import { NextResponse } from 'next/server'

export type ApiError = {
  error: string
  code?: string
  details?: unknown
}

export function apiError(
  status: number,
  message: string,
  details?: unknown,
  code?: string,
): NextResponse<ApiError> {
  const body: ApiError = { error: message }
  if (code) body.code = code
  if (details !== undefined) body.details = details
  return NextResponse.json(body, { status })
}

// Log a Supabase / Postgres error server-side and return a generic error to
// the client. Postgres error.message often leaks column names, RLS hints, or
// constraint names — we don't want any of that on the wire.
export function dbError(
  scope: string,
  err: unknown,
  status = 500,
  code = 'db_error',
): NextResponse<ApiError> {
  console.error(`[${scope}]`, err)
  return apiError(status, 'Database error', undefined, code)
}

// Generic server-error helper for 5xx paths that would otherwise leak
// upstream Postgres / provider error messages (which can expose schema
// names, constraint names, and internal state). Logs the full error
// server-side, returns a generic message keyed by `code` to the client.
export function apiServerError(
  context: string,
  err: unknown,
  code = 'server_error',
  status = 500,
): NextResponse<ApiError> {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[api] ${context}:`, detail)
  return apiError(status, 'Internal server error', undefined, code)
}
