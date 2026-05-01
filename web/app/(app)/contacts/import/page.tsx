import Link from 'next/link'
import { ImportClient } from './ImportClient'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Import contacts · Jarvis',
}

export default function ContactImportPage() {
  return (
    <div className="-mx-4 -my-8 sm:-mx-6">
      <div className="relative isolate overflow-hidden bg-zinc-950 text-zinc-100">
        {/* ambient gradient glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        >
          <div className="absolute -top-40 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-gradient-to-br from-indigo-500/30 via-violet-500/20 to-fuchsia-500/20 blur-3xl" />
          <div className="absolute -bottom-32 right-0 h-[320px] w-[480px] rounded-full bg-fuchsia-500/10 blur-3xl" />
        </div>

        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-200"
          >
            ← Back to dashboard
          </Link>

          <header className="mt-6">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-indigo-200 ring-1 ring-inset ring-indigo-400/30">
              <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
              Relationship Intelligence
            </span>
            <h1 className="mt-4 bg-gradient-to-r from-indigo-200 via-violet-200 to-fuchsia-200 bg-clip-text text-3xl font-semibold tracking-tight text-transparent sm:text-4xl">
              Import contacts
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-zinc-400 sm:text-base">
              Drop in a CSV from LinkedIn, your CRM, or a spreadsheet — or add a
              single contact by hand. We&apos;ll auto-map common columns and
              show you a preview before anything is saved.
            </p>
          </header>

          <div className="mt-10">
            <ImportClient />
          </div>
        </div>
      </div>
    </div>
  )
}
