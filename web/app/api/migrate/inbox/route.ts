import { NextResponse } from 'next/server'
import { createClient } from '../../../../lib/supabase/server'
import { getServiceClient } from '../../../../lib/supabase/service'
import { apiError } from '../../../../lib/api-errors'

export const dynamic = 'force-dynamic'

// ONE-TIME migration endpoint — delete after use
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return apiError(401, 'Unauthorized', undefined, 'unauthorized')

  const service = getServiceClient()
  if (!service) return apiError(500, 'No service key', undefined, 'no_service_key')

  const sql = `
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL,
      sender TEXT,
      recipient TEXT,
      subject TEXT,
      body TEXT,
      snippet TEXT,
      thread_id TEXT,
      reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL,
      external_id TEXT,
      external_url TEXT,
      is_read BOOLEAN DEFAULT false,
      is_starred BOOLEAN DEFAULT false,
      is_archived BOOLEAN DEFAULT false,
      sent_at TIMESTAMPTZ NOT NULL,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, channel, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_user_inbox ON messages(user_id, is_archived, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_user_channel ON messages(user_id, channel, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_user_contact ON messages(user_id, contact_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(user_id, is_read, sent_at DESC) WHERE is_read = false;

    ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'messages' AND policyname = 'Users can read own messages') THEN
        CREATE POLICY "Users can read own messages" ON messages FOR SELECT USING (auth.uid() = user_id);
      END IF;
    END $$;
  `

  const { error } = await service.rpc('exec_sql', { sql_text: sql }).single()

  // If rpc doesn't exist, try raw query via postgrest
  if (error) {
    // Fallback: use the service client to just verify the table exists
    // The SQL needs to be run via dashboard or CLI
    return NextResponse.json({
      ok: false,
      error: error.message,
      note: 'Run the migration SQL manually in Supabase SQL Editor',
      sql
    })
  }

  return NextResponse.json({ ok: true, message: 'Messages table created' })
}
