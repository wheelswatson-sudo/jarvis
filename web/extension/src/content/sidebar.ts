import { rpc } from '../lib/messages'
import type {
  ContactMatch,
  ExtractedProfile,
  SidebarContext,
} from '../lib/types'

const HOST_ID = 'ri-sidebar-host'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function ensureHost(): HTMLElement {
  let host = document.getElementById(HOST_ID)
  if (host) return host
  host = el('div')
  host.id = HOST_ID
  host.className = 'ri-sidebar-host'
  document.body.appendChild(host)
  return host
}

function destroy(): void {
  document.getElementById(HOST_ID)?.remove()
}

function healthClass(label: string): string {
  const lower = label.toLowerCase()
  if (lower.startsWith('strong') || lower.startsWith('healthy')) {
    return 'ri-health ri-health-strong'
  }
  if (lower.startsWith('cooling')) return 'ri-health ri-health-cooling'
  if (lower.startsWith('cold')) return 'ri-health ri-health-cold'
  return 'ri-health'
}

function fmtDays(iso: string | null): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const days = Math.floor((Date.now() - t) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

function fmtDue(iso: string | null): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

function header(): HTMLElement {
  const wrap = el('div', 'ri-sidebar-header')
  const logo = el('div', 'ri-sidebar-logo', 'RI')
  const title = el('div', 'ri-sidebar-title', 'Relationship Intelligence')
  const collapse = el('button', 'ri-sidebar-collapse', '–') as HTMLButtonElement
  collapse.title = 'Collapse'
  collapse.addEventListener('click', () => {
    const host = document.getElementById(HOST_ID)
    if (!host) return
    host.classList.toggle('ri-sidebar-collapsed')
    collapse.textContent = host.classList.contains('ri-sidebar-collapsed')
      ? '+'
      : '–'
  })
  const close = el('button', 'ri-sidebar-close', '×') as HTMLButtonElement
  close.title = 'Close'
  close.addEventListener('click', destroy)
  wrap.append(logo, title, collapse, close)
  return wrap
}

export function renderUnmatched(
  profile: ExtractedProfile,
  reason: string,
): void {
  const host = ensureHost()
  host.innerHTML = ''
  host.append(header())
  const body = el('div', 'ri-unmatched')
  body.append(el('div', 'ri-name', profile.name ?? 'Unknown profile'))
  body.append(el('div', 'ri-subtitle', reason))
  body.append(
    el(
      'div',
      'ri-status',
      'No matching contact in your RI database. Add them through the web app to start tracking.',
    ),
  )
  host.append(body)
}

export function renderError(message: string): void {
  const host = ensureHost()
  host.innerHTML = ''
  host.append(header())
  const body = el('div', 'ri-sidebar-body')
  body.append(el('div', 'ri-status ri-status-error', message))
  host.append(body)
}

export function renderLoading(label: string): void {
  const host = ensureHost()
  host.innerHTML = ''
  host.append(header())
  const body = el('div', 'ri-sidebar-body')
  body.append(el('div', 'ri-status', label))
  host.append(body)
}

export function detectChanges(
  match: ContactMatch,
  profile: ExtractedProfile,
): SidebarContext['detected_changes'] {
  const changes: SidebarContext['detected_changes'] = []
  const newTitle = profile.title ?? profile.headline ?? null
  if (newTitle && match.title && newTitle !== match.title) {
    changes.push({ field: 'title', old: match.title, new: newTitle })
  }
  if (profile.company && match.company && profile.company !== match.company) {
    changes.push({ field: 'company', old: match.company, new: profile.company })
  }
  return changes
}

export function renderMatched(
  match: ContactMatch,
  context: SidebarContext,
  profile: ExtractedProfile,
): void {
  const host = ensureHost()
  host.innerHTML = ''
  host.append(header())

  const body = el('div', 'ri-sidebar-body')

  body.append(el('div', 'ri-name', context.contact.name))
  const subtitleParts: string[] = []
  if (context.contact.title) subtitleParts.push(context.contact.title)
  if (context.contact.company) subtitleParts.push(context.contact.company)
  if (subtitleParts.length > 0) {
    body.append(el('div', 'ri-subtitle', subtitleParts.join(' · ')))
  }

  body.append(el('div', healthClass(context.health_label), context.health_label))

  if (context.last_interaction_summary) {
    body.append(el('div', 'ri-section-title', 'Last interaction'))
    const item = el('div', 'ri-list-item')
    item.textContent = context.last_interaction_summary
    const meta = el(
      'span',
      'ri-meta',
      fmtDays(context.contact.last_interaction_at),
    )
    item.append(meta)
    body.append(item)
  }

  if (context.open_commitments.length > 0) {
    body.append(el('div', 'ri-section-title', 'Open commitments'))
    const list = el('ul', 'ri-list')
    for (const c of context.open_commitments) {
      const item = el('li', 'ri-list-item')
      item.textContent = `${c.owner === 'them' ? '[they owe]' : '[you owe]'} ${c.description}`
      if (c.due_at) {
        item.append(el('span', 'ri-meta', `due ${fmtDue(c.due_at)}`))
      }
      list.append(item)
    }
    body.append(list)
  }

  if (context.next_follow_up) {
    body.append(el('div', 'ri-section-title', 'Next follow-up'))
    body.append(el('div', 'ri-list-item', fmtDue(context.next_follow_up)))
  }

  const detected = detectChanges(match, profile)
  if (detected.length > 0) {
    const changes = el('div', 'ri-changes')
    changes.append(el('div', 'ri-changes-title', 'Detected changes'))
    for (const c of detected) {
      const line = el('div')
      line.textContent = `${c.field}: ${c.old ?? '∅'} → ${c.new ?? '∅'}`
      changes.append(line)
    }
    body.append(changes)
  }

  const actions = el('div', 'ri-actions')
  const logBtn = el('button', 'ri-button', 'Log update') as HTMLButtonElement
  const status = el('div', 'ri-status')
  logBtn.addEventListener('click', async () => {
    logBtn.disabled = true
    logBtn.textContent = 'Saving…'
    status.className = 'ri-status'
    status.textContent = ''
    const res = await rpc({
      kind: 'social-update',
      contactId: match.id,
      profile,
    })
    if (res.ok) {
      logBtn.textContent = 'Saved ✓'
      status.className = 'ri-status ri-status-success'
      status.textContent = 'Profile snapshot logged to RI.'
    } else {
      logBtn.disabled = false
      logBtn.textContent = 'Log update'
      status.className = 'ri-status ri-status-error'
      status.textContent = res.error
    }
  })
  const openBtn = el(
    'button',
    'ri-button-ghost',
    'Open in RI',
  ) as HTMLButtonElement
  openBtn.addEventListener('click', async () => {
    const settings = await rpc({ kind: 'get-settings' })
    if (settings.ok) {
      window.open(`${settings.data.baseUrl}/contacts/${match.id}`, '_blank')
    }
  })
  actions.append(logBtn, openBtn)
  body.append(actions)
  body.append(status)

  host.append(body)
}
