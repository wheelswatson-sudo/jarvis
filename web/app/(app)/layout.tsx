import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import { NavBar } from '../../components/NavBar'
import { Chat } from '../../components/Chat'

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
    <div className="min-h-screen bg-white">
      <NavBar email={user.email ?? null} />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
      <Chat />
    </div>
  )
}
