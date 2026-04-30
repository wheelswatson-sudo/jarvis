'use client'

import { useEffect, useRef, useState } from 'react'

type Message = { role: 'user' | 'jarvis'; text: string }

export function Chat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, open])

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setMessages((m) => [...m, { role: 'user', text }])
    setDraft('')
    setSending(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = (await res.json()) as { reply?: string; error?: string }
      setMessages((m) => [
        ...m,
        { role: 'jarvis', text: data.reply ?? data.error ?? 'No reply.' },
      ])
    } catch {
      setMessages((m) => [
        ...m,
        { role: 'jarvis', text: 'Failed to reach Jarvis.' },
      ])
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end">
      {open && (
        <div className="mb-3 flex h-[28rem] w-[22rem] flex-col rounded-lg border border-zinc-200 bg-white">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <div className="text-sm font-medium">Chat with Jarvis</div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-zinc-400 hover:text-zinc-700"
              aria-label="Close chat"
            >
              ×
            </button>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <p className="text-sm text-zinc-400">
                Ask anything about your relationships, commitments, or queue.
              </p>
            )}
            <div className="space-y-3">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`text-sm ${
                    m.role === 'user' ? 'text-right' : 'text-left'
                  }`}
                >
                  <div
                    className={`inline-block max-w-[85%] rounded-lg px-3 py-2 ${
                      m.role === 'user'
                        ? 'bg-zinc-900 text-white'
                        : 'bg-zinc-100 text-zinc-900'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
            className="border-t border-zinc-200 p-3"
          >
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Message Jarvis…"
                className="flex-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </form>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:border-zinc-300"
      >
        {open ? 'Close chat' : 'Chat with Jarvis'}
      </button>
    </div>
  )
}
