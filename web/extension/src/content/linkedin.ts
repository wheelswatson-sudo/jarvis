import { rpc } from '../lib/messages'
import type { ExtractedProfile } from '../lib/types'
import {
  renderError,
  renderLoading,
  renderMatched,
  renderUnmatched,
} from './sidebar'

const PROFILE_PATH = /^\/in\/[^/]+\/?$/
let lastProcessedUrl: string | null = null

function canonicalUrl(): string | null {
  const path = location.pathname.replace(/\/+$/, '/')
  if (!PROFILE_PATH.test(path)) return null
  const slug = path.split('/').filter(Boolean)[1]
  if (!slug) return null
  return `https://www.linkedin.com/in/${slug}/`
}

function meta(name: string): string | null {
  const m = document.querySelector<HTMLMetaElement>(
    `meta[property="${name}"], meta[name="${name}"]`,
  )
  return m?.content?.trim() || null
}

function text(selector: string, root: ParentNode = document): string | null {
  const node = root.querySelector(selector)
  return node?.textContent?.trim() || null
}

function firstText(
  selectors: string[],
  root: ParentNode = document,
): string | null {
  for (const sel of selectors) {
    const t = text(sel, root)
    if (t) return t
  }
  return null
}

function splitTitleCompany(headline: string | null): {
  title: string | null
  company: string | null
} {
  if (!headline) return { title: null, company: null }
  const parts = headline.split(/\s+(?:at|@|·)\s+/i)
  if (parts.length >= 2) {
    return {
      title: parts[0]?.trim() || null,
      company: parts.slice(1).join(' at ').trim() || null,
    }
  }
  return { title: headline, company: null }
}

function extractRecentPosts(): string[] {
  const posts: string[] = []
  const nodes = document.querySelectorAll(
    '.feed-shared-update-v2, [data-urn*="urn:li:activity"]',
  )
  for (const n of Array.from(nodes).slice(0, 5)) {
    const t = n.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    if (t.length > 0) posts.push(t.slice(0, 280))
  }
  return posts
}

function extractProfile(url: string): ExtractedProfile {
  const ogTitle = meta('og:title')
  const headlineFromMeta = meta('og:description')
  const name =
    firstText([
      'main h1',
      'h1.text-heading-xlarge',
      'section.pv-top-card h1',
    ]) ??
    (ogTitle ? ogTitle.split('|')[0]?.trim() ?? null : null)

  const headline =
    firstText([
      '.text-body-medium.break-words',
      'div.pv-text-details__left-panel .text-body-medium',
    ]) ?? headlineFromMeta

  const location = firstText([
    'span.text-body-small.inline.t-black--light.break-words',
    '.pv-text-details__left-panel span.text-body-small',
  ])

  const about = firstText([
    'section.pv-about-section .pv-shared-text-with-see-more',
    'section[aria-labelledby="about"] .display-flex.full-width',
    '#about ~ * .inline-show-more-text',
  ])

  const photo = document.querySelector<HTMLImageElement>(
    'img.pv-top-card-profile-picture__image, button img.profile-photo-edit__preview, img.profile-picture-image',
  )
  const profile_photo_url = photo?.src ?? meta('og:image')

  const currentExperience = firstText([
    'section[data-section="currentPositionsDetails"] .t-bold',
    'div#experience ~ * .t-bold',
  ])

  const { title, company } = splitTitleCompany(headline)
  const fallbackCompany = currentExperience ?? company

  return {
    source: 'linkedin',
    url,
    name,
    headline,
    title,
    company: fallbackCompany,
    location,
    about,
    profile_photo_url,
    recent_posts: extractRecentPosts(),
    current_city: location,
    workplace: fallbackCompany,
    life_events: [],
  }
}

async function process(): Promise<void> {
  const url = canonicalUrl()
  if (!url) return
  if (url === lastProcessedUrl) return
  lastProcessedUrl = url

  // LinkedIn renders profile DOM after navigation; wait for the h1 to land.
  await waitFor(
    () =>
      document.querySelector(
        'main h1, h1.text-heading-xlarge, section.pv-top-card h1',
      ) !== null,
    8000,
  )

  const profile = extractProfile(url)
  if (!profile.name) {
    renderUnmatched(profile, 'Could not read profile from page.')
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
    renderUnmatched(profile, profile.headline ?? 'No headline')
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
    }, 200)
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
