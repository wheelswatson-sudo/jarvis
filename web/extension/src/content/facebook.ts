import { rpc } from '../lib/messages'
import type { ExtractedProfile } from '../lib/types'
import {
  renderError,
  renderLoading,
  renderMatched,
  renderUnmatched,
} from './sidebar'

const NON_PROFILE_PATHS = new Set([
  'home',
  'login',
  'logout',
  'marketplace',
  'watch',
  'gaming',
  'groups',
  'events',
  'messages',
  'notifications',
  'settings',
  'help',
  'pages',
  'photo.php',
  'photo',
  'profile.php',
  'reels',
  'stories',
  'live',
  'pages_feeds',
  'business',
  'ads',
  'friends',
])

let lastProcessedUrl: string | null = null

function canonicalUrl(): string | null {
  const path = location.pathname.split('/').filter(Boolean)
  if (path.length === 0) return null
  const first = path[0]!
  if (first === 'profile.php') {
    const id = new URLSearchParams(location.search).get('id')
    return id ? `https://www.facebook.com/profile.php?id=${id}` : null
  }
  if (NON_PROFILE_PATHS.has(first)) return null
  // Sub-paths under a profile (e.g. /username/about) still belong to that profile
  return `https://www.facebook.com/${first}/`
}

function meta(name: string): string | null {
  const m = document.querySelector<HTMLMetaElement>(
    `meta[property="${name}"], meta[name="${name}"]`,
  )
  return m?.content?.trim() || null
}

function firstText(selectors: string[]): string | null {
  for (const sel of selectors) {
    const node = document.querySelector(sel)
    const t = node?.textContent?.trim()
    if (t) return t
  }
  return null
}

function extractFromLabeled(label: string): string | null {
  // Facebook About sections use varying markup, but commonly
  // pair an icon/label with adjacent text. Walk anchors that link to
  // pages tagged for cities/work and pull their text.
  const re = new RegExp(label, 'i')
  const candidates = document.querySelectorAll('div[role="main"] *')
  for (const c of Array.from(candidates).slice(0, 4000)) {
    const t = c.textContent?.trim() ?? ''
    if (re.test(t) && t.length < 240) {
      return t.replace(re, '').replace(/^[:\s]+/, '').trim() || null
    }
  }
  return null
}

function extractRecentPosts(): string[] {
  const posts: string[] = []
  const nodes = document.querySelectorAll('div[role="article"]')
  for (const n of Array.from(nodes).slice(0, 5)) {
    const t = n.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    if (t.length > 0) posts.push(t.slice(0, 280))
  }
  return posts
}

function extractProfile(url: string): ExtractedProfile {
  const ogTitle = meta('og:title')
  const ogDesc = meta('og:description')
  const name =
    firstText(['div[role="main"] h1']) ??
    (ogTitle ? ogTitle.split('|')[0]?.trim() ?? null : null)
  const headline = ogDesc

  const photo =
    document.querySelector<HTMLImageElement>('image, svg image')?.getAttribute(
      'xlink:href',
    ) ??
    document.querySelector<HTMLImageElement>('div[role="main"] image')?.getAttribute(
      'xlink:href',
    ) ??
    meta('og:image')

  const currentCity = extractFromLabeled('Lives in')
  const workplace = extractFromLabeled('Works at') ?? extractFromLabeled('Worked at')

  const lifeEvents: string[] = []
  const eventNodes = document.querySelectorAll('div[role="article"] strong')
  for (const e of Array.from(eventNodes).slice(0, 5)) {
    const t = e.textContent?.trim() ?? ''
    if (t.length > 0 && t.length < 120) lifeEvents.push(t)
  }

  return {
    source: 'facebook',
    url,
    name,
    headline,
    title: null,
    company: workplace,
    location: currentCity,
    about: ogDesc,
    profile_photo_url: photo,
    recent_posts: extractRecentPosts(),
    current_city: currentCity,
    workplace,
    life_events: lifeEvents,
  }
}

async function process(): Promise<void> {
  const url = canonicalUrl()
  if (!url) return
  if (url === lastProcessedUrl) return
  lastProcessedUrl = url

  await waitFor(
    () => document.querySelector('div[role="main"] h1') !== null,
    8000,
  )

  const profile = extractProfile(url)
  if (!profile.name) {
    return
  }

  renderLoading('Looking up RI…')

  const settings = await rpc({ kind: 'get-settings' })
  if (!settings.ok || !settings.data.token) {
    renderError('Connect RI in the extension popup to enable matching.')
    return
  }

  const match = await rpc({ kind: 'match', url, name: profile.name })
  if (!match.ok) {
    if (match.status === 401) {
      renderError('RI auth failed. Check your token in the extension popup.')
    } else {
      renderError(match.error)
    }
    return
  }
  if (!match.data.match) {
    renderUnmatched(profile, profile.headline ?? '')
    return
  }

  const context = await rpc({
    kind: 'context',
    contactId: match.data.match.id,
  })
  if (!context.ok) {
    renderError(context.error)
    return
  }
  renderMatched(match.data.match, context.data, profile)
}

function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (check()) {
      resolve()
      return
    }
    const start = Date.now()
    const interval = setInterval(() => {
      if (check() || Date.now() - start > timeoutMs) {
        clearInterval(interval)
        resolve()
      }
    }, 250)
  })
}

function watchUrlChanges(): void {
  let last = location.href
  const tick = () => {
    if (location.href !== last) {
      last = location.href
      lastProcessedUrl = null
      void process()
    }
  }
  setInterval(tick, 800)
  window.addEventListener('popstate', tick)
}

void process()
watchUrlChanges()
