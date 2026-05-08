'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

type ToastTone = 'success' | 'error' | 'info'

type Toast = {
  id: number
  message: string
  tone: ToastTone
  action?: { label: string; onClick: () => void }
}

type ToastApi = {
  success: (message: string, action?: Toast['action']) => void
  error: (message: string, action?: Toast['action']) => void
  info: (message: string, action?: Toast['action']) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback(
    (tone: ToastTone, message: string, action?: Toast['action']) => {
      const id = Date.now() + Math.random()
      setToasts((prev) => [...prev, { id, message, tone, action }])
      // Errors stick longer so the user can read and react.
      const ttl = tone === 'error' ? 7000 : 4000
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, ttl)
    },
    [],
  )

  const api: ToastApi = {
    success: (m, a) => push('success', m, a),
    error: (m, a) => push('error', m, a),
    info: (m, a) => push('info', m, a),
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 space-y-2 px-4 sm:left-auto sm:right-4 sm:translate-x-0"
      >
        {toasts.map((t) => (
          <ToastChip
            key={t.id}
            toast={t}
            onDismiss={() =>
              setToasts((prev) => prev.filter((x) => x.id !== t.id))
            }
          />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastChip({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 10)
    return () => clearTimeout(t)
  }, [])
  const tone =
    toast.tone === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      : toast.tone === 'error'
        ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
        : 'border-violet-500/30 bg-violet-500/10 text-violet-200'
  return (
    <div
      role="status"
      className={`pointer-events-auto flex max-w-sm items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg shadow-black/40 backdrop-blur-md transition-all duration-200 ${tone} ${shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
    >
      <span className="flex-1 leading-snug">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action!.onClick()
            onDismiss()
          }}
          className="shrink-0 rounded-md border border-white/15 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-100 transition-colors hover:bg-white/[0.08]"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
      >
        ×
      </button>
    </div>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // Fail open: render nothing if Provider missing. The app layout always
    // wraps with ToastProvider, but rendering outside it (e.g. in storybook)
    // shouldn't crash.
    return {
      success: () => {},
      error: () => {},
      info: () => {},
    }
  }
  return ctx
}
