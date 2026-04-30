'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import { createClient } from '../lib/supabase/client'
import { Brand } from './Brand'

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/commitments', label: 'Commitments' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/settings', label: 'Settings' },
]

export function NavBar({ email }: { email: string | null }) {
  const pathname = usePathname()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function signOut() {
    setBusy(true)
    const supabase = createClient()
    await supabase.auth.signOut()
    router.replace('/login')
    router.refresh()
  }

  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Link href="/" className="hover:opacity-70 transition-opacity">
            <Brand />
          </Link>
          <nav className="hidden gap-6 sm:flex">
            {NAV.map((item) => {
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`text-sm transition-colors ${
                    active
                      ? 'text-zinc-900 font-medium'
                      : 'text-zinc-500 hover:text-zinc-900'
                  }`}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          {email && (
            <span className="hidden text-sm text-zinc-500 sm:inline">{email}</span>
          )}
          <button
            type="button"
            onClick={signOut}
            disabled={busy}
            className="text-sm text-zinc-500 hover:text-zinc-900 disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
