-- Migration 008 — daily-briefing intelligence metrics
--
-- Adds three columns to contacts that the /api/intelligence/compute-metrics
-- endpoint populates and the daily-briefing endpoint consumes:
--
--   sentiment_trajectory   REAL          slope of recent interaction sentiment
--                                        (positive = warming, negative = cooling)
--   reciprocity_ratio      REAL          inbound / outbound count over rolling
--                                        90 days (1.0 = balanced, <1 = you
--                                        reach out more, >1 = they reach out
--                                        more). NULL when there's no outbound
--                                        traffic yet.
--   metrics_computed_at    TIMESTAMPTZ   last time the compute job ran for
--                                        this contact, used to skip recently
--                                        computed rows on cron.
--
-- daily_briefings caches the assembled briefing so the UI doesn't have to
-- regenerate on every page load.
--
-- Idempotent — safe to re-run. Apply via Supabase SQL editor (project
-- wsoxrooqlxaezkwogcfr).

-- ---------------------------------------------------------------------------
-- contacts — metrics columns
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists sentiment_trajectory real;

alter table public.contacts
  add column if not exists reciprocity_ratio real;

alter table public.contacts
  add column if not exists metrics_computed_at timestamptz;

-- Sort cooling relationships fastest — most negative slope first.
create index if not exists contacts_sentiment_trajectory_idx
  on public.contacts (user_id, sentiment_trajectory asc nulls last)
  where sentiment_trajectory is not null;

-- Sort reciprocity outliers — lowest ratio (you doing all the reaching) first.
create index if not exists contacts_reciprocity_ratio_idx
  on public.contacts (user_id, reciprocity_ratio asc nulls last)
  where reciprocity_ratio is not null;

-- ---------------------------------------------------------------------------
-- daily_briefings — cached briefing payload
-- ---------------------------------------------------------------------------
create table if not exists public.daily_briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  briefing_date date not null,
  payload jsonb not null,
  markdown text not null,
  generated_at timestamptz not null default now()
);

create unique index if not exists daily_briefings_user_date_idx
  on public.daily_briefings (user_id, briefing_date);

create index if not exists daily_briefings_user_generated_idx
  on public.daily_briefings (user_id, generated_at desc);

alter table public.daily_briefings enable row level security;

drop policy if exists "daily_briefings_select_own" on public.daily_briefings;
create policy "daily_briefings_select_own"
  on public.daily_briefings for select
  using (auth.uid() = user_id);

-- INSERT/UPDATE intentionally happen via the service-role client only —
-- the briefing endpoint authenticates the session, then writes through the
-- service role (mirrors the intelligence_insights pattern).
