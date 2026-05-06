'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'
import './globals.css'

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body className="min-h-screen bg-[#07070b] text-zinc-100">
        <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
          <div
            aria-hidden="true"
            className="mb-6 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-rose-500/20 via-fuchsia-500/15 to-violet-500/20 ring-1 ring-inset ring-white/10 text-rose-300"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.3 3.86l-8.5 14.7A2 2 0 003.5 21h17a2 2 0 001.7-2.44l-8.5-14.7a2 2 0 00-3.4 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold tracking-tight aiea-gradient-text">
            Something went wrong
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            We&apos;ve been notified and are looking into it.
          </p>
          {error.digest && (
            <p className="mt-3 font-mono text-xs text-zinc-500">
              ref: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="mt-8 rounded-lg aiea-cta px-4 py-2 text-sm font-medium text-white"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
