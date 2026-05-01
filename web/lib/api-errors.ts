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
