import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { apiError } from '../../../../lib/api-errors'

export const dynamic = 'force-dynamic'

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiError(401, 'Unauthorized', undefined, 'unauthorized')
  }

  const { error } = await supabase
    .from('profiles')
    .upsert(
      { id: user.id, onboarded_at: new Date().toISOString() },
      { onConflict: 'id' },
    )

  if (error) {
    return apiError(500, error.message, undefined, 'db_error')
  }
  return NextResponse.json({ ok: true })
}
