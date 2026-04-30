-- Migration 002 — user_api_keys table + preferred_model column on profiles
--
-- `user_api_keys` stores per-provider API keys for each user (one active key
-- per provider). `profiles.preferred_model` records the model the user picks
-- in the settings page. Apply via the Supabase SQL editor.

alter table public.profiles
  add column if not exists preferred_model text;

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  api_key text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists user_api_keys_user_id_idx
  on public.user_api_keys (user_id);

alter table public.user_api_keys enable row level security;

drop policy if exists "user_api_keys_select_own" on public.user_api_keys;
create policy "user_api_keys_select_own"
  on public.user_api_keys for select
  using (auth.uid() = user_id);

drop policy if exists "user_api_keys_insert_own" on public.user_api_keys;
create policy "user_api_keys_insert_own"
  on public.user_api_keys for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_api_keys_update_own" on public.user_api_keys;
create policy "user_api_keys_update_own"
  on public.user_api_keys for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_api_keys_delete_own" on public.user_api_keys;
create policy "user_api_keys_delete_own"
  on public.user_api_keys for delete
  using (auth.uid() = user_id);

create or replace function public.touch_user_api_keys_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_api_keys_touch_updated_at on public.user_api_keys;
create trigger user_api_keys_touch_updated_at
  before update on public.user_api_keys
  for each row execute function public.touch_user_api_keys_updated_at();
