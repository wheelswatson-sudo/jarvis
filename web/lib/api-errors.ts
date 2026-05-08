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
