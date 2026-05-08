import { createClient } from '../../../lib/supabase/server'
import { FeedbackView, type FeedbackRow } from './FeedbackView'

export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'wheels.watson@gmail.com'

export default async function FeedbackPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: rows } = await supabase
    .from('feedback')
    .select(
      'id, user_id, requester_email, title, description, category, status, admin_response, resolved_at, created_at, updated_at',
    )
    .order('created_at', { ascending: false })

  return (
    <FeedbackView
      currentUserId={user?.id ?? null}
      currentUserEmail={user?.email ?? null}
      isAdmin={(user?.email ?? '').toLowerCase() === ADMIN_EMAIL}
      initialRows={(rows ?? []) as FeedbackRow[]}
    />
  )
}
