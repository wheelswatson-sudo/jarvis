import type { Settings } from './types'

const KEY = 'ri_settings'
const DEFAULT_BASE_URL = 'https://relationship-intelligence-blue.vercel.app'

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY)
  const raw = stored[KEY] as Partial<Settings> | undefined
  return {
    baseUrl: raw?.baseUrl?.trim() || DEFAULT_BASE_URL,
    token: raw?.token ?? null,
  }
}

export async function saveSettings(s: Settings): Promise<Settings> {
  const next: Settings = {
    baseUrl: s.baseUrl.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL,
    token: s.token?.trim() || null,
  }
  await chrome.storage.local.set({ [KEY]: next })
  return next
}
