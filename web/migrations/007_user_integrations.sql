-- Migration 007 — user_integrations table
--
-- Stores per-user OAuth credentials for third-party integrations that are
-- separate from the Supabase auth provider used for login (e.g., Google
-- Contacts via the People API). One row per (user_id, provider).
--
-- Refresh tokens never leave the server: the Settings UI only ever reads
-- account_email / last_synced_at / scopes through server components.
-- Writes happen via the service-role client from the OAuth callback and
-- sync routes; the SELECT policy lets the user see their own connection
-- status without exposing tokens to a non-authenticated client.
--
-- Idempotent — safe to re-run. Apply via the Supabase SQL editor.

create table if not exists public.user_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  account_email text,
  refresh_token text,
  access_token text,
  access_token_expires_at timestamptz,
  scopes text[],
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists user_integrations_user_id_idx
  on public.user_integrations (user_id);

alter table public.user_integrations enable row level security;

drop policy if exists "user_integrations_select_own" on public.user_integrations;
create policy "user_integrations_select_own"
  on public.user_integrations for select
  using (auth.uid() = user_id);

drop policy if exists "user_integrations_delete_own" on public.user_integrations;
create policy "user_integrations_delete_own"
  on public.user_integrations for delete
  using (auth.uid() = user_id);

-- INSERT/UPDATE intentionally happen via the service-role client only
-- (the OAuth callback needs to write the refresh token, and the sync
-- route needs to update access_token / last_synced_at).

create or replace function public.touch_user_integrations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_integrations_touch_updated_at on public.user_integrations;
create trigger user_integrations_touch_updated_at
  before update on public.user_integrations
  for each row execute function public.touch_user_integrations_updated_at();
