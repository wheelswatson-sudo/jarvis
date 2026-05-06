'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import { createClient } from '../lib/supabase/client'
import { Brand } from './Brand'

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/briefing', label: 'Briefing' },
  { href: '/commitments', label: 'Commitments' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/settings', label: 'Settings' },
]

export function NavBar({ email }: { email: string | null }) {
  const pathname = usePathname()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  async function signOut() {
    setBusy(true)
    const supabase = createClient()
    await supabase.auth.signOut()
    router.replace('/login')
    router.refresh()
  }

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#07070b]/70 backdrop-blur-xl supports-[backdrop-filter]:bg-[#07070b]/55">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-10">
          <Link
            href="/"
            className="inline-flex items-center transition-opacity hover:opacity-80"
            aria-label="AIEA home"
          >
            <Brand />
          </Link>
          <nav className="hidden items-center gap-1 sm:flex" aria-label="Primary">
            {NAV.map((item) => {
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-active={active}
                  className={`aiea-nav-pill rounded-md px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? 'text-white'
                      : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {email && (
            <span className="hidden max-w-[180px] truncate text-xs text-zinc-500 lg:inline">
              {email}
            </span>
          )}
          <button
            type="button"
            onClick={signOut}
            disabled={busy}
            className="hidden rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-50 sm:inline-flex"
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-controls="aiea-mobile-nav"
            aria-label="Toggle navigation"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.02] text-zinc-300 sm:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {menuOpen ? (
                <>
                  <path d="M6 6l12 12" />
                  <path d="M6 18L18 6" />
                </>
              ) : (
                <>
                  <path d="M4 7h16" />
                  <path d="M4 12h16" />
                  <path d="M4 17h16" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav
          id="aiea-mobile-nav"
          className="border-t border-white/[0.06] bg-[#07070b]/90 px-4 py-3 sm:hidden"
          aria-label="Mobile primary"
        >
          <ul className="space-y-1">
            {NAV.map((item) => {
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(item.href)
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMenuOpen(false)}
                    className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                      active
                        ? 'bg-white/[0.06] text-white'
                        : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-100'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            })}
            <li>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  signOut()
                }}
                disabled={busy}
                className="mt-2 w-full rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-left text-sm text-zinc-300 disabled:opacity-50"
              >
                {busy ? 'Signing out…' : 'Sign out'}
                {email && (
                  <span className="ml-2 text-xs text-zinc-500">({email})</span>
                )}
              </button>
            </li>
          </ul>
        </nav>
      )}
    </header>
  )
}
