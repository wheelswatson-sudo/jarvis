import * as api from './lib/api'
import type { RpcRequest, RpcResponse } from './lib/messages'
import { loadSettings, saveSettings } from './lib/storage'

async function handle(request: RpcRequest): Promise<RpcResponse> {
  try {
    switch (request.kind) {
      case 'get-settings': {
        const data = await loadSettings()
        return { kind: 'get-settings', result: { ok: true, data } }
      }
      case 'set-settings': {
        const data = await saveSettings(request.settings)
        return { kind: 'set-settings', result: { ok: true, data } }
      }
      case 'ping': {
        const data = await api.ping()
        return { kind: 'ping', result: { ok: true, data } }
      }
      case 'match': {
        const data = await api.matchProfile(request.url, request.name)
        return { kind: 'match', result: { ok: true, data } }
      }
      case 'context': {
        const data = await api.getContext(request.contactId)
        return { kind: 'context', result: { ok: true, data } }
      }
      case 'social-update': {
        const data = await api.postSocialUpdate(
          request.contactId,
          request.profile,
        )
        return { kind: 'social-update', result: { ok: true, data } }
      }
      case 'stale-list': {
        const data = await api.getStaleList()
        return { kind: 'stale-list', result: { ok: true, data } }
      }
      case 'search': {
        const data = await api.searchContacts(request.query)
        return { kind: 'search', result: { ok: true, data } }
      }
    }
  } catch (err) {
    const status = err instanceof api.ApiError ? err.status : undefined
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      kind: request.kind,
      result: { ok: false, error: message, status },
    } as RpcResponse
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message as RpcRequest).then(sendResponse)
  return true
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ri-stale-check') {
    void refreshBadge()
  }
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('ri-stale-check', { periodInMinutes: 60 })
  void refreshBadge()
})

chrome.runtime.onStartup.addListener(() => {
  void refreshBadge()
})

async function refreshBadge(): Promise<void> {
  const settings = await loadSettings()
  if (!settings.token) {
    await chrome.action.setBadgeText({ text: '' })
    return
  }
  try {
    const { contacts } = await api.getStaleList()
    const count = contacts.length
    await chrome.action.setBadgeBackgroundColor({ color: '#6366f1' })
    await chrome.action.setBadgeText({
      text: count > 0 ? String(Math.min(count, 99)) : '',
    })
  } catch {
    await chrome.action.setBadgeText({ text: '' })
  }
}
