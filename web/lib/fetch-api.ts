import type { ApiError } from './api-errors'

export class FetchApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown
  readonly url: string

  constructor(
    message: string,
    options: {
      status: number
      url: string
      code?: string
      details?: unknown
    },
  ) {
    super(message)
    this.name = 'FetchApiError'
    this.status = options.status
    this.code = options.code
    this.details = options.details
    this.url = options.url
  }
}

async function readErrorBody(
  res: Response,
): Promise<{ message: string; code?: string; details?: unknown }> {
  const contentType = res.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      const body = (await res.json()) as Partial<ApiError> & Record<string, unknown>
      const message =
        typeof body.error === 'string' && body.error.length > 0
          ? body.error
          : `${res.status} ${res.statusText}`
      return {
        message,
        code: typeof body.code === 'string' ? body.code : undefined,
        details: body.details,
      }
    }
    const text = await res.text()
    return {
      message:
        text && text.length > 0 ? text : `${res.status} ${res.statusText}`,
    }
  } catch {
    return { message: `${res.status} ${res.statusText}` }
  }
}

export async function fetchAPI<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, options)
  } catch (cause) {
    throw new FetchApiError(
      cause instanceof Error ? cause.message : 'Network request failed',
      { status: 0, url, code: 'network_error' },
    )
  }

  if (!res.ok) {
    const { message, code, details } = await readErrorBody(res)
    throw new FetchApiError(message, {
      status: res.status,
      url,
      code,
      details,
    })
  }

  if (res.status === 204) return undefined as T

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return (await res.json()) as T
  }
  return (await res.text()) as unknown as T
}
