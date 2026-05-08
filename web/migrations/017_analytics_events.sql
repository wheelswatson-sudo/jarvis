-- Migration 017 — analytics_events
--
-- Lightweight per-user product analytics. The browser writes directly to
-- this table via the anon key + RLS (no API round-trip), so we only allow
-- INSERT and SELECT on the user's own rows. The existing intelligence
-- `events` table is a separate, richer feed used by the AIEA pipeline; this
-- one is for plain product telemetry — page views, button clicks, sync
-- triggers, errors.
--
-- Idempotent — safe to re-run.

create table if not exists public.analytics_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  event_name  text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists analytics_events_user_created_idx
  on public.analytics_events (user_id, created_at desc);

create index if not exists analytics_events_user_event_idx
  on public.analytics_events (user_id, event_name, created_at desc);

alter table public.analytics_events enable row level security;

drop policy if exists "analytics_events_insert_own" on public.analytics_events;
create policy "analytics_events_insert_own"
  on public.analytics_events for insert
  with check (auth.uid() = user_id);

drop policy if exists "analytics_events_select_own" on public.analytics_events;
create policy "analytics_events_select_own"
  on public.analytics_events for select
  using (auth.uid() = user_id);
