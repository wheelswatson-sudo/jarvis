import { rpc } from '../lib/messages'
import type { ContactMatch, Settings, StaleContact } from '../lib/types'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} missing`)
  return el as T
}

const status = $('ri-pop-status')
const baseUrlInput = $<HTMLInputElement>('ri-pop-base-url')
const tokenInput = $<HTMLTextAreaElement>('ri-pop-token')
const saveBtn = $<HTMLButtonElement>('ri-pop-save')
const testBtn = $<HTMLButtonElement>('ri-pop-test')
const settingsStatus = $('ri-pop-settings-status')
const staleList = $('ri-pop-stale-list')
const searchInput = $<HTMLInputElement>('ri-pop-search')
const searchResults = $('ri-pop-search-results')

function setStatus(label: string, kind: '' | 'ok' | 'err'): void {
  status.textContent = label
  status.className = 'ri-pop-status' + (kind ? ` ${kind}` : '')
}

function setSettingsStatus(label: string, kind: '' | 'ok' | 'err'): void {
  settingsStatus.textContent = label
  settingsStatus.className = 'ri-pop-feedback' + (kind ? ` ${kind}` : '')
}

async function openContact(contactId: string): Promise<void> {
  const settings = await rpc({ kind: 'get-settings' })
  if (settings.ok) {
    chrome.tabs.create({
      url: `${settings.data.baseUrl}/contacts/${contactId}`,
    })
  }
}

function row(
  primary: string,
  secondary: string,
  onClick: () => void,
): HTMLDivElement {
  const div = document.createElement('div')
  div.className = 'ri-pop-row'
  const name = document.createElement('div')
  name.className = 'ri-pop-row-name'
  name.textContent = primary
  const meta = document.createElement('div')
  meta.className = 'ri-pop-row-meta'
  meta.textContent = secondary
  div.append(name, meta)
  div.addEventListener('click', onClick)
  return div
}

function fmtDays(d: number | null): string {
  if (d == null) return '—'
  if (d <= 0) return 'today'
  if (d === 1) return '1d'
  return `${d}d`
}

async function renderStale(): Promise<void> {
  staleList.innerHTML = ''
  const res = await rpc({ kind: 'stale-list' })
  if (!res.ok) {
    const empty = document.createElement('div')
    empty.className = 'ri-pop-empty'
    empty.textContent =
      res.status === 401
        ? 'Sign in to see contacts.'
        : `Couldn't load: ${res.error}`
    staleList.append(empty)
    return
  }
  const contacts: StaleContact[] = res.data.contacts
  if (contacts.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'ri-pop-empty'
    empty.textContent = 'Inbox zero — nobody is overdue.'
    staleList.append(empty)
    return
  }
  for (const c of contacts.slice(0, 10)) {
    staleList.append(
      row(c.name, `${fmtDays(c.days_since)} · ${c.source}`, () => {
        if (c.social_url) {
          chrome.tabs.create({ url: c.social_url })
        } else {
          void openContact(c.id)
        }
      }),
    )
  }
}

let searchSeq = 0
async function runSearch(query: string): Promise<void> {
  const mySeq = ++searchSeq
  searchResults.innerHTML = ''
  const trimmed = query.trim()
  if (trimmed.length < 2) return
  const res = await rpc({ kind: 'search', query: trimmed })
  if (mySeq !== searchSeq) return
  if (!res.ok) {
    const empty = document.createElement('div')
    empty.className = 'ri-pop-empty'
    empty.textContent = res.error
    searchResults.append(empty)
    return
  }
  const contacts: ContactMatch[] = res.data.contacts
  if (contacts.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'ri-pop-empty'
    empty.textContent = 'No matches.'
    searchResults.append(empty)
    return
  }
  for (const c of contacts.slice(0, 8)) {
    const meta = [c.title, c.company].filter(Boolean).join(' · ')
    searchResults.append(
      row(c.name, meta || '—', () => void openContact(c.id)),
    )
  }
}

async function loadSettings(): Promise<Settings> {
  const res = await rpc({ kind: 'get-settings' })
  if (!res.ok) {
    return { baseUrl: '', token: null }
  }
  return res.data
}

async function saveSettingsFromForm(): Promise<Settings | null> {
  const settings: Settings = {
    baseUrl: baseUrlInput.value,
    token: tokenInput.value || null,
  }
  const res = await rpc({ kind: 'set-settings', settings })
  if (!res.ok) {
    setSettingsStatus(res.error, 'err')
    return null
  }
  baseUrlInput.value = res.data.baseUrl
  if (res.data.token) tokenInput.value = res.data.token
  return res.data
}

async function testConnection(): Promise<void> {
  setSettingsStatus('Pinging…', '')
  const res = await rpc({ kind: 'ping' })
  if (res.ok) {
    setStatus('connected', 'ok')
    setSettingsStatus(`Connected as ${res.data.user}`, 'ok')
    void renderStale()
  } else {
    setStatus('offline', 'err')
    setSettingsStatus(res.error, 'err')
  }
}

async function init(): Promise<void> {
  const s = await loadSettings()
  baseUrlInput.value = s.baseUrl
  tokenInput.value = s.token ?? ''
  if (!s.token) {
    setStatus('not connected', 'err')
    setSettingsStatus('Paste an auth token to connect.', '')
  } else {
    void testConnection()
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true
    const saved = await saveSettingsFromForm()
    if (saved) {
      await testConnection()
    }
    saveBtn.disabled = false
  })

  testBtn.addEventListener('click', () => {
    void testConnection()
  })

  let debounce: number | undefined
  searchInput.addEventListener('input', () => {
    if (debounce) window.clearTimeout(debounce)
    debounce = window.setTimeout(() => void runSearch(searchInput.value), 250)
  })
}

void init()
