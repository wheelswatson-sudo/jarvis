'use client'

import { useEffect, useRef, useState } from 'react'

type Role = 'user' | 'assistant'
type Message = { role: Role; content: string }

const SUGGESTED_PROMPTS = [
  'Who should I follow up with this week?',
  'What commitments are overdue?',
  'Summarize my last conversation with my top contacts',
  'Which Tier 1 relationships are cooling?',
] as const

export function Chat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, open])

  async function send(textOverride?: string) {
    const text = (textOverride ?? draft).trim()
    if (!text || sending) return
    const next: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setDraft('')
    setSending(true)

    setMessages((m) => [...m, { role: 'assistant', content: '' }])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      })

      if (!res.ok || !res.body) {
        let errMsg = `Failed (${res.status})`
        try {
          const j = (await res.json()) as { error?: string }
          if (j.error) errMsg = j.error
        } catch {
          // ignore
        }
        setMessages((m) => {
          const copy = [...m]
          copy[copy.length - 1] = { role: 'assistant', content: errMsg }
          return copy
        })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let acc = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })
        setMessages((m) => {
          const copy = [...m]
          copy[copy.length - 1] = { role: 'assistant', content: acc }
          return copy
        })
      }
    } catch {
      setMessages((m) => {
        const copy = [...m]
        copy[copy.length - 1] = {
          role: 'assistant',
          content: 'Failed to reach AIEA.',
        }
        return copy
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed bottom-4 right-4 left-4 z-50 flex flex-col items-end sm:left-auto">
      {open && (
        <div className="mb-3 flex h-[min(28rem,calc(100vh-7rem))] w-full flex-col overflow-hidden rounded-2xl aiea-glass-strong shadow-2xl shadow-violet-500/10 animate-fade-up sm:w-[22rem]">
          <div className="flex items-center justify-between border-b border-white/[0.06] bg-gradient-to-r from-indigo-500/[0.08] via-violet-500/[0.06] to-fuchsia-500/[0.08] px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-indigo-500/30 via-violet-500/25 to-fuchsia-500/30 ring-1 ring-inset ring-white/15"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-violet-200"
                  aria-hidden="true"
                >
                  <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
                  <path d="M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
                </svg>
              </span>
              <div className="text-sm font-medium text-zinc-100">
                Chat with AIEA
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
              aria-label="Close chat"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12" />
                <path d="M6 18L18 6" />
              </svg>
            </button>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="px-1 py-2">
                <p className="text-center text-xs text-zinc-500">
                  Ask anything about your relationships, commitments, or
                  queue.
                </p>
                <div className="mt-4 space-y-1.5">
                  <div className="px-1 text-[10px] uppercase tracking-wider text-zinc-600">
                    Try asking
                  </div>
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => send(prompt)}
                      className="block w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:border-violet-500/30 hover:bg-white/[0.04] hover:text-zinc-100"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
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
                    className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 leading-relaxed ${
                      m.role === 'user'
                        ? 'bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/20'
                        : 'border border-white/[0.06] bg-white/[0.03] text-zinc-100'
                    }`}
                  >
                    {m.content ||
                      (sending && i === messages.length - 1 ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.3s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.15s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400" />
                        </span>
                      ) : (
                        ''
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
            className="border-t border-white/[0.06] p-3"
          >
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Message AIEA…"
                className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="rounded-lg aiea-cta px-3.5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
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
        className={`group inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-500/20 transition-all ${
          open
            ? 'border border-white/[0.08] bg-white/[0.04] backdrop-blur-xl text-zinc-200'
            : 'aiea-cta'
        }`}
      >
        {open ? (
          <>Close chat</>
        ) : (
          <>
            <span
              aria-hidden="true"
              className="relative flex h-2 w-2"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
            </span>
            Chat with AIEA
          </>
        )}
      </button>
    </div>
  )
}
