'use client'

import { useState, useEffect, useTransition } from 'react'

type ContactSlim = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  company: string | null
}

type Message = {
  id: string
  channel: string
  direction: 'inbound' | 'outbound'
  sender: string | null
  recipient: string | null
  subject: string | null
  snippet: string | null
  thread_id: string | null
  external_url: string | null
  is_read: boolean
  is_starred: boolean
  is_archived: boolean
  sent_at: string
  contact_id: string | null
  contacts: ContactSlim | null
}

const CHANNELS = [
  { key: null, label: 'All' },
  { key: 'email', label: 'Email' },
  { key: 'imessage', label: 'iMessage' },
  { key: 'sms', label: 'SMS' },
  { key: 'slack', label: 'Slack' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'facebook', label: 'Facebook' },
] as const

function contactName(c: ContactSlim | null): string {
  if (!c) return ''
  const parts = [c.first_name, c.last_name].filter(Boolean)
  return parts.join(' ') || 'Unknown'
}

function senderDisplay(msg: Message): string {
  if (msg.contacts) return contactName(msg.contacts)
  if (msg.sender) {
    const m = msg.sender.match(/^"?([^"<]+)"?\s*</)
    if (m) return m[1].trim()
    return msg.sender.split('@')[0]
  }
  return 'Unknown'
}

function senderInitials(msg: Message): string {
  const name = senderDisplay(msg)
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (name.slice(0, 2) || '··').toUpperCase()
}

const CHANNEL_TONE: Record<string, string> = {
  email: 'bg-indigo-500/10 text-indigo-200 ring-indigo-500/30',
  imessage: 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/30',
  sms: 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/30',
  slack: 'bg-violet-500/10 text-violet-200 ring-violet-500/30',
  telegram: 'bg-sky-500/10 text-sky-200 ring-sky-500/30',
  linkedin: 'bg-indigo-500/10 text-indigo-200 ring-indigo-500/30',
  facebook: 'bg-blue-500/10 text-blue-200 ring-blue-500/30',
}

function channelBadge(ch: string) {
  const cls = CHANNEL_TONE[ch] ?? 'bg-white/[0.04] text-zinc-300 ring-white/10'
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${cls}`}
    >
      {ch}
    </span>
  )
}

function timeAgo(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const mins = Math.floor((now - then) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString()
}

export default function InboxPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (channel) params.set('channel', channel)
    params.set('limit', '100')

    fetch(`/api/inbox?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setMessages(data.messages ?? [])
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }, [channel])

  function markRead(ids: string[]) {
    startTransition(async () => {
      await fetch('/api/inbox', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, updates: { is_read: true } }),
      })
      setMessages((prev) =>
        prev.map((m) => (ids.includes(m.id) ? { ...m, is_read: true } : m)),
      )
    })
  }

  function toggleStar(id: string, current: boolean) {
    startTransition(async () => {
      await fetch('/api/inbox', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], updates: { is_starred: !current } }),
      })
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, is_starred: !current } : m)),
      )
    })
  }

  function archiveMessage(id: string) {
    startTransition(async () => {
      await fetch('/api/inbox', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], updates: { is_archived: true } }),
      })
      setMessages((prev) => prev.filter((m) => m.id !== id))
      if (selected === id) setSelected(null)
    })
  }

  const selectedMsg = messages.find((m) => m.id === selected)
  const unreadCount = messages.filter((m) => !m.is_read).length

  return (
    <div className="flex h-[calc(100vh-7rem)] overflow-hidden rounded-2xl aiea-glass animate-fade-up">
      {/* Sidebar */}
      <div className="hidden w-52 shrink-0 flex-col border-r border-white/[0.05] bg-white/[0.01] p-3 sm:flex">
        <div className="mb-3 px-2 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
          Channels
        </div>
        <div className="space-y-1">
          {CHANNELS.map((ch) => {
            const isActive = channel === ch.key
            return (
              <button
                key={ch.key ?? 'all'}
                type="button"
                onClick={() => setChannel(ch.key)}
                className={`group flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  isActive
                    ? 'bg-gradient-to-r from-indigo-500/15 to-fuchsia-500/10 text-white ring-1 ring-inset ring-violet-500/30'
                    : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-100'
                }`}
              >
                <span>{ch.label}</span>
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-indigo-400 to-fuchsia-400"
                  />
                )}
              </button>
            )
          })}
        </div>

        <div className="mt-auto rounded-lg border border-white/[0.05] bg-white/[0.02] p-3 text-xs text-zinc-500">
          <div className="tabular-nums">
            <span className="text-zinc-300">{messages.length}</span> messages
          </div>
          {unreadCount > 0 && (
            <div className="mt-0.5 tabular-nums text-violet-300">
              {unreadCount} unread
            </div>
          )}
        </div>
      </div>

      {/* Message list */}
      <div className="w-full max-w-md shrink-0 overflow-y-auto border-r border-white/[0.05]">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-[aiea-spin-slow_0.9s_linear_infinite] rounded-full border-2 border-violet-500/30 border-t-violet-400" />
          </div>
        )}

        {error && (
          <div className="m-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
            {error}
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="px-6 py-16 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 ring-1 ring-inset ring-white/10 text-violet-200">
              <InboxIcon />
            </div>
            <p className="text-sm text-zinc-300">No messages yet</p>
            <p className="mt-1 text-xs text-zinc-500">
              Sync your Gmail from Settings to populate your inbox.
            </p>
          </div>
        )}

        {messages.map((msg) => {
          const isSelected = selected === msg.id
          return (
            <button
              key={msg.id}
              type="button"
              onClick={() => {
                setSelected(msg.id)
                if (!msg.is_read) markRead([msg.id])
              }}
              className={`flex w-full items-start gap-3 border-b border-white/[0.04] px-4 py-3 text-left transition-colors ${
                isSelected
                  ? 'bg-gradient-to-r from-indigo-500/[0.06] via-violet-500/[0.04] to-fuchsia-500/[0.06]'
                  : 'hover:bg-white/[0.025]'
              }`}
            >
              <span
                aria-hidden="true"
                className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500/25 via-violet-500/20 to-fuchsia-500/25 text-[11px] font-semibold text-white ring-1 ring-inset ring-white/10"
              >
                {senderInitials(msg)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {!msg.is_read && (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-r from-indigo-400 to-fuchsia-400 shadow-[0_0_8px_rgba(139,92,246,0.7)]"
                      />
                    )}
                    <span
                      className={`truncate text-sm ${
                        msg.is_read
                          ? 'text-zinc-300'
                          : 'font-semibold text-zinc-50'
                      }`}
                    >
                      {msg.direction === 'inbound'
                        ? senderDisplay(msg)
                        : `To: ${senderDisplay(msg)}`}
                    </span>
                  </div>
                  <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
                    {timeAgo(msg.sent_at)}
                  </span>
                </div>
                {msg.subject && (
                  <div
                    className={`mt-0.5 truncate text-xs ${
                      msg.is_read
                        ? 'text-zinc-500'
                        : 'font-medium text-zinc-300'
                    }`}
                  >
                    {msg.subject}
                  </div>
                )}
                {msg.snippet && (
                  <div className="mt-0.5 line-clamp-1 text-xs text-zinc-500">
                    {msg.snippet}
                  </div>
                )}
                <div className="mt-1.5 flex items-center gap-1.5">
                  {channelBadge(msg.channel)}
                  {msg.is_starred && (
                    <span
                      aria-label="Starred"
                      className="text-[11px] text-amber-300"
                    >
                      ★
                    </span>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Detail */}
      <div className="hidden flex-1 overflow-y-auto md:block">
        {!selectedMsg && (
          <div className="flex h-full items-center justify-center px-6">
            <div className="text-center">
              <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 ring-1 ring-inset ring-white/10 text-violet-200 animate-float">
                <MailIcon />
              </div>
              <p className="text-sm text-zinc-400">Select a message to read</p>
            </div>
          </div>
        )}

        {selectedMsg && (
          <div className="p-6 sm:p-8 animate-fade-in">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold tracking-tight text-zinc-50">
                    {senderDisplay(selectedMsg)}
                  </h2>
                  {channelBadge(selectedMsg.channel)}
                  {selectedMsg.direction === 'outbound' && (
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium text-zinc-400 ring-1 ring-inset ring-white/10">
                      Sent
                    </span>
                  )}
                </div>
                {selectedMsg.contacts?.company && (
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {selectedMsg.contacts.company}
                  </p>
                )}
                {selectedMsg.subject && (
                  <p className="mt-2 text-base font-medium text-zinc-200">
                    {selectedMsg.subject}
                  </p>
                )}
                <p className="mt-1 text-xs text-zinc-500">
                  {new Date(selectedMsg.sent_at).toLocaleString()}
                  {selectedMsg.sender && (
                    <span className="font-mono">
                      {' '}
                      · {selectedMsg.sender}
                    </span>
                  )}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    toggleStar(selectedMsg.id, selectedMsg.is_starred)
                  }
                  className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-amber-300"
                  title={selectedMsg.is_starred ? 'Unstar' : 'Star'}
                >
                  {selectedMsg.is_starred ? '★' : '☆'}
                </button>
                <button
                  type="button"
                  onClick={() => archiveMessage(selectedMsg.id)}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
                >
                  Archive
                </button>
              </div>
            </div>

            <div className="mt-6 border-t border-white/[0.05] pt-6">
              <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
                {selectedMsg.snippet}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function InboxIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 13l3-9h12l3 9" />
      <path d="M3 13h5l1.5 3h5L16 13h5v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6z" />
    </svg>
  )
}
function MailIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 7 9-7" />
    </svg>
  )
}
