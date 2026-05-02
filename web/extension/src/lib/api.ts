import { loadSettings } from './storage'
import type {
  ContactMatch,
  ExtractedProfile,
  SidebarContext,
  StaleContact,
} from './types'

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const settings = await loadSettings()
  if (!settings.token) {
    throw new ApiError(401, 'No auth token configured')
  }
  const url = `${settings.baseUrl}${path}`
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${settings.token}`)
  headers.set('accept', 'application/json')
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // non-JSON error body — keep default
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

export async function ping(): Promise<{ ok: true; user: string }> {
  return request('/api/extension/ping')
}

export async function matchProfile(
  url: string,
  name: string | null,
): Promise<{ match: ContactMatch | null }> {
  const params = new URLSearchParams({ url })
  if (name) params.set('name', name)
  return request(`/api/extension/match?${params.toString()}`)
}

export async function getContext(
  contactId: string,
): Promise<SidebarContext> {
  return request(`/api/extension/context/${contactId}`)
}

export async function postSocialUpdate(
  contactId: string,
  profile: ExtractedProfile,
): Promise<{ updated: true }> {
  return request('/api/extension/social-update', {
    method: 'POST',
    body: JSON.stringify({ contact_id: contactId, profile }),
  })
}

export async function getStaleList(): Promise<{ contacts: StaleContact[] }> {
  return request('/api/extension/stale')
}

export async function searchContacts(
  query: string,
): Promise<{ contacts: ContactMatch[] }> {
  const params = new URLSearchParams({ q: query })
  return request(`/api/extension/search?${params.toString()}`)
}

export { ApiError }
