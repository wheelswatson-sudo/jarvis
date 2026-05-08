-- Migration 019 — feedback hardening
--
-- Two gaps in migration 018 that are worth closing before this table sees
-- real traffic:
--
--   1. The INSERT policy only checked auth.uid() = user_id. It did not
--      constrain `status`, `admin_response`, `resolved_at`, or
--      `requester_email`, so a hostile client (or a stock supabase-js call
--      that sets these fields) could land rows that look like Watson-
--      approved changelog entries. The browser UI never sets them, but RLS
--      is the only thing that stops a curl + anon key.
--
--   2. `resolved_at` was set client-side from the admin Edit panel. Any
--      other path that moves status (a SQL-editor fix, a future cron, a
--      future admin route) would leave resolved_at out of sync. A trigger
--      is the right place to enforce the invariant — set it on transition
--      into shipped|wont-fix, clear it on transition out.
--
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Tighten INSERT RLS.
-- ---------------------------------------------------------------------------
-- Replace the INSERT policy. New rows must:
--   - belong to the calling user (unchanged)
--   - start in 'open' with no admin response and no resolved_at
--   - either omit requester_email or set it to the caller's JWT email,
--     so requester attribution can't be spoofed
drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own"
  on public.feedback for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and status = 'open'
    and admin_response is null
    and resolved_at is null
    and (
      requester_email is null
      or requester_email = (auth.jwt() ->> 'email')
    )
  );

-- ---------------------------------------------------------------------------
-- 2. resolved_at sync trigger.
-- ---------------------------------------------------------------------------
-- BEFORE INSERT OR UPDATE: when status is shipped or wont-fix, ensure
-- resolved_at is populated. When status is anything else, clear it.
-- Preserves an existing resolved_at for ship/wont-fix rows so we don't
-- bump the timestamp on every unrelated UPDATE (e.g. editing the response).
create or replace function public.sync_feedback_resolved_at()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('shipped', 'wont-fix') then
    if new.resolved_at is null then
      new.resolved_at := now();
    end if;
  else
    new.resolved_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists feedback_sync_resolved_at on public.feedback;
create trigger feedback_sync_resolved_at
  before insert or update on public.feedback
  for each row execute function public.sync_feedback_resolved_at();
