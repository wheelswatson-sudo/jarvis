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
  { key: null, label: 'All', icon: '📥' },
  { key: 'email', label: 'Email', icon: '📧' },
  { key: 'imessage', label: 'iMessage', icon: '💬' },
  { key: 'sms', label: 'SMS', icon: '📱' },
  { key: 'slack', label: 'Slack', icon: '💼' },
  { key: 'telegram', label: 'Telegram', icon: '✈️' },
  { key: 'linkedin', label: 'LinkedIn', icon: '🔗' },
  { key: 'facebook', label: 'Facebook', icon: '👤' },
] as const

function contactName(c: ContactSlim | null): string {
  if (!c) return ''
  const parts = [c.first_name, c.last_name].filter(Boolean)
  return parts.join(' ') || 'Unknown'
}

function senderDisplay(msg: Message): string {
  if (msg.contacts) return contactName(msg.contacts)
  if (msg.sender) {
    // Extract name from "Name <email>" format
    const m = msg.sender.match(/^"?([^"<]+)"?\s*</)
    if (m) return m[1].trim()
    return msg.sender.split('@')[0]
  }
  return 'Unknown'
}

function channelBadge(ch: string) {
  const colors: Record<string, string> = {
    email: 'bg-blue-50 text-blue-600 border-blue-200',
    imessage: 'bg-green-50 text-green-600 border-green-200',
    sms: 'bg-emerald-50 text-emerald-600 border-emerald-200',
    slack: 'bg-purple-50 text-purple-600 border-purple-200',
    telegram: 'bg-sky-50 text-sky-600 border-sky-200',
    linkedin: 'bg-indigo-50 text-indigo-600 border-indigo-200',
    facebook: 'bg-blue-50 text-blue-700 border-blue-200',
  }
  const cls = colors[ch] ?? 'bg-zinc-50 text-zinc-600 border-zinc-200'
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
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
  const [isPending, startTransition] = useTransition()

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
    <div className="flex h-[calc(100vh-8rem)] overflow-hidden rounded-xl border border-zinc-200">
      {/* Sidebar: channel filters */}
      <div className="w-48 shrink-0 border-r border-zinc-100 bg-zinc-50/50 p-3">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Channels
        </div>
        {CHANNELS.map((ch) => {
          const isActive = channel === ch.key
          return (
            <button
              key={ch.key ?? 'all'}
              type="button"
              onClick={() => setChannel(ch.key)}
              className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                isActive
                  ? 'bg-white font-medium text-zinc-900 shadow-sm'
                  : 'text-zinc-600 hover:bg-white/60'
              }`}
            >
              <span className="text-base">{ch.icon}</span>
              {ch.label}
            </button>
          )
        })}

        <div className="mt-6 border-t border-zinc-200 pt-4">
          <div className="text-xs text-zinc-400">
            {messages.length} messages
            {unreadCount > 0 && (
              <span className="ml-1 text-indigo-500">· {unreadCount} unread</span>
            )}
          </div>
        </div>
      </div>

      {/* Message list */}
      <div className="w-80 shrink-0 overflow-y-auto border-r border-zinc-100 lg:w-96">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900" />
          </div>
        )}

        {error && (
          <div className="m-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
            {error}
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="px-4 py-16 text-center">
            <div className="text-3xl">📭</div>
            <p className="mt-2 text-sm text-zinc-500">
              No messages yet. Sync your Gmail from Settings to populate your inbox.
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
              className={`flex w-full flex-col border-b border-zinc-50 px-4 py-3 text-left transition-colors ${
                isSelected
                  ? 'bg-indigo-50/50'
                  : msg.is_read
                    ? 'hover:bg-zinc-50'
                    : 'bg-white hover:bg-zinc-50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {!msg.is_read && (
                    <div className="h-2 w-2 shrink-0 rounded-full bg-indigo-500" />
                  )}
                  <span
                    className={`truncate text-sm ${
                      msg.is_read ? 'text-zinc-600' : 'font-semibold text-zinc-900'
                    }`}
                  >
                    {msg.direction === 'inbound' ? senderDisplay(msg) : `To: ${senderDisplay(msg)}`}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {channelBadge(msg.channel)}
                  <span className="text-[11px] text-zinc-400">{timeAgo(msg.sent_at)}</span>
                </div>
              </div>

              {msg.subject && (
                <div
                  className={`mt-0.5 truncate text-xs ${
                    msg.is_read ? 'text-zinc-500' : 'font-medium text-zinc-700'
                  }`}
                >
                  {msg.subject}
                </div>
              )}

              {msg.snippet && (
                <div className="mt-0.5 truncate text-xs text-zinc-400">
                  {msg.snippet}
                </div>
              )}
            </button>
          )
        })}
      </div>

      {/* Message detail */}
      <div className="flex-1 overflow-y-auto bg-white">
        {!selectedMsg && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="text-4xl">📬</div>
              <p className="mt-2 text-sm text-zinc-400">Select a message to read</p>
            </div>
          </div>
        )}

        {selectedMsg && (
          <div className="p-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-zinc-900">
                    {senderDisplay(selectedMsg)}
                  </h2>
                  {channelBadge(selectedMsg.channel)}
                  {selectedMsg.direction === 'outbound' && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
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
                  <p className="mt-1 text-sm text-zinc-700">{selectedMsg.subject}</p>
                )}
                <p className="mt-1 text-xs text-zinc-400">
                  {new Date(selectedMsg.sent_at).toLocaleString()}
                  {selectedMsg.sender && ` · ${selectedMsg.sender}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleStar(selectedMsg.id, selectedMsg.is_starred)}
                  className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-50 transition-colors"
                  title={selectedMsg.is_starred ? 'Unstar' : 'Star'}
                >
                  {selectedMsg.is_starred ? '⭐' : '☆'}
                </button>
                <button
                  type="button"
                  onClick={() => archiveMessage(selectedMsg.id)}
                  className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
                >
                  Archive
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="mt-6 border-t border-zinc-100 pt-6">
              <div className="prose prose-sm prose-zinc max-w-none whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">
                {selectedMsg.snippet}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
