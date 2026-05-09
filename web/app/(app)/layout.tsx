import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { NavBar } from '../../components/NavBar'
import { Chat } from '../../components/Chat'
import { FeedbackFAB } from '../../components/FeedbackFAB'
import { AutoSyncOnLogin } from '../../components/AutoSyncOnLogin'
import { AnalyticsTracker } from '../../components/AnalyticsTracker'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#07070b] text-zinc-100">
      {/* Ambient aurora — fixed page background */}
      <div className="aiea-aurora-bg" aria-hidden="true" />
      <div
        className="pointer-events-none fixed inset-0 z-0 opacity-60"
        aria-hidden="true"
      >
        <div className="aiea-grid h-full w-full" />
      </div>

      <div className="relative z-10">
        <NavBar email={user.email ?? null} />
        <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
          {children}
        </main>
        <Chat />
        <FeedbackFAB />
        <AutoSyncOnLogin />
        <AnalyticsTracker />
      </div>
    </div>
  )
}
