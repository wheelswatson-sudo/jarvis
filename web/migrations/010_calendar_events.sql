-- Migration 010 — calendar_events table
--
-- Persists Google Calendar events into Supabase so the daily briefing's
-- "today's meetings" section can render without a Google round-trip on
-- every page load. Synced via the calendar sync route (and the daily cron).
--
-- Schema is shaped to match what `lib/intelligence/daily-briefing.ts`
-- already expects: { id, user_id, title, start_at, end_at, attendees,
-- contact_id }. We also keep the Google `external_id` for dedup so
-- re-syncing the same window doesn't duplicate rows.
--
-- Apply via the Supabase SQL editor (project: wsoxrooqlxaezkwogcfr).
-- Idempotent — safe to re-run.

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  external_id text not null,
  calendar_id text not null default 'primary',
  title text,
  description text,
  location text,
  start_at timestamptz not null,
  end_at timestamptz,
  is_all_day boolean not null default false,
  attendees jsonb not null default '[]'::jsonb,
  organizer jsonb,
  conference_url text,
  html_link text,
  status text,
  contact_id uuid references public.contacts(id) on delete set null,
  source text not null default 'google_calendar',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, external_id)
);

create index if not exists calendar_events_user_start_idx
  on public.calendar_events (user_id, start_at);

create index if not exists calendar_events_contact_idx
  on public.calendar_events (contact_id) where contact_id is not null;

alter table public.calendar_events enable row level security;

drop policy if exists "calendar_events_select_own" on public.calendar_events;
create policy "calendar_events_select_own"
  on public.calendar_events for select
  using (auth.uid() = user_id);

drop policy if exists "calendar_events_insert_own" on public.calendar_events;
create policy "calendar_events_insert_own"
  on public.calendar_events for insert
  with check (auth.uid() = user_id);

drop policy if exists "calendar_events_update_own" on public.calendar_events;
create policy "calendar_events_update_own"
  on public.calendar_events for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "calendar_events_delete_own" on public.calendar_events;
create policy "calendar_events_delete_own"
  on public.calendar_events for delete
  using (auth.uid() = user_id);

create or replace function public.touch_calendar_events_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists calendar_events_touch_updated_at on public.calendar_events;
create trigger calendar_events_touch_updated_at
  before update on public.calendar_events
  for each row execute function public.touch_calendar_events_updated_at();
