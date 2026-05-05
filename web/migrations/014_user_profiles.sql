-- Migration 014 — user_profiles (AIEA Layer 1: Observation)
--
-- Stores learned behavioral signals about each executive. One row per user,
-- recomputed daily from the last 90 days of messages, calendar_events,
-- interactions, and commitments. Read by the daily-briefing LLM step so
-- recommendations are grounded in the executive's actual patterns.
--
-- Apply via the Supabase SQL editor (project: wsoxrooqlxaezkwogcfr).
-- Idempotent — safe to re-run.

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  avg_response_time_minutes numeric,
  fast_reply_contacts jsonb not null default '[]'::jsonb,
  slow_reply_contacts jsonb not null default '[]'::jsonb,
  active_hours_start smallint check (active_hours_start between 0 and 23),
  active_hours_end smallint check (active_hours_end between 0 and 23),
  meeting_tolerance_daily numeric,
  top_contacts jsonb not null default '[]'::jsonb,
  communication_style jsonb not null default '{}'::jsonb,
  last_computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_user_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_profiles_touch_updated_at on public.user_profiles;
create trigger user_profiles_touch_updated_at
  before update on public.user_profiles
  for each row execute function public.touch_user_profiles_updated_at();

alter table public.user_profiles enable row level security;

drop policy if exists "user_profiles_select_own" on public.user_profiles;
create policy "user_profiles_select_own"
  on public.user_profiles for select
  using (auth.uid() = user_id);

-- Writes happen via the service role from the daily compute job; service
-- role bypasses RLS so no user-side INSERT/UPDATE policies are needed.
