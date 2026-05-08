-- Migration 018 — feedback
--
-- User-submitted feature requests, bug reports, and improvement ideas.
-- Visible to all authenticated users so they can see what's been requested
-- and what has shipped. Only Watson (the admin) can update rows — to set
-- status, write a response, or mark resolved.
--
-- Admin gating uses the JWT email claim (`auth.jwt() ->> 'email'`) compared
-- against Watson's address. Hardcoded because this is a single-admin app;
-- if a second admin is ever added, swap to a `profiles.is_admin` boolean.
--
-- Idempotent — safe to re-run.

create table if not exists public.feedback (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  -- Denormalized at insert so the changelog can attribute requests
  -- without granting cross-user reads of auth.users.
  requester_email text,
  title           text not null,
  description     text not null,
  category        text not null
    check (category in ('bug', 'feature', 'improvement')),
  status          text not null default 'open'
    check (status in ('open', 'in-progress', 'shipped', 'wont-fix')),
  admin_response  text,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.feedback
  add column if not exists requester_email text;

create index if not exists feedback_created_idx
  on public.feedback (created_at desc);

create index if not exists feedback_status_idx
  on public.feedback (status, created_at desc);

create index if not exists feedback_user_idx
  on public.feedback (user_id, created_at desc);

create or replace function public.touch_feedback_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists feedback_touch_updated_at on public.feedback;
create trigger feedback_touch_updated_at
  before update on public.feedback
  for each row execute function public.touch_feedback_updated_at();

alter table public.feedback enable row level security;

-- Anyone authenticated can read every row (public-changelog model).
drop policy if exists "feedback_select_all_authenticated" on public.feedback;
create policy "feedback_select_all_authenticated"
  on public.feedback for select
  to authenticated
  using (true);

-- Authenticated users can insert their own rows. user_id is forced to
-- match the JWT subject so a malicious client can't impersonate.
drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own"
  on public.feedback for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Only Watson can update — to set status, write admin_response, etc.
drop policy if exists "feedback_update_admin_only" on public.feedback;
create policy "feedback_update_admin_only"
  on public.feedback for update
  to authenticated
  using ((auth.jwt() ->> 'email') = 'wheels.watson@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'wheels.watson@gmail.com');
