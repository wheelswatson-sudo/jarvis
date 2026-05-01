import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { error } = await supabase
    .from('profiles')
    .upsert(
      { id: user.id, onboarded_at: new Date().toISOString() },
      { onConflict: 'id' },
    )

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
