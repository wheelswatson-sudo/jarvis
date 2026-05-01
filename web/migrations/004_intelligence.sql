-- Migration 004 — self-improving intelligence system
--
-- Four tables that together form the learning loop:
--
--   events                — every meaningful user action (the raw signal)
--   experience_capsules   — patterns the engine has learned (the ECAP store)
--   intelligence_insights — actionable recommendations surfaced from capsules
--   system_health_log     — audit trail of analysis runs and self-monitoring
--
-- Apply via the Supabase SQL editor (project: wsoxrooqlxaezkwogcfr).
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in (
    'contact_viewed',
    'contact_updated',
    'outreach_sent',
    'commitment_created',
    'commitment_completed',
    'commitment_missed',
    'import_completed',
    'chat_query',
    'insight_dismissed',
    'insight_acted_on'
  )),
  contact_id uuid references public.contacts(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_user_created_idx
  on public.events (user_id, created_at desc);

create index if not exists events_user_type_created_idx
  on public.events (user_id, event_type, created_at desc);

create index if not exists events_contact_idx
  on public.events (contact_id) where contact_id is not null;

alter table public.events enable row level security;

drop policy if exists "events_select_own" on public.events;
create policy "events_select_own"
  on public.events for select
  using (auth.uid() = user_id);

drop policy if exists "events_insert_own" on public.events;
create policy "events_insert_own"
  on public.events for insert
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- experience_capsules — learned patterns (ECAP)
-- ---------------------------------------------------------------------------
create table if not exists public.experience_capsules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pattern_type text not null check (pattern_type in (
    'timing_preference',
    'engagement_pattern',
    'relationship_decay',
    'outreach_effectiveness',
    'contact_priority'
  )),
  pattern_key text not null,
  pattern_data jsonb not null default '{}'::jsonb,
  confidence_score real not null default 0
    check (confidence_score >= 0 and confidence_score <= 1),
  sample_size integer not null default 0
    check (sample_size >= 0),
  status text not null default 'emerging'
    check (status in ('emerging', 'confirmed', 'deployed', 'stale')),
  first_observed_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists experience_capsules_user_pattern_idx
  on public.experience_capsules (user_id, pattern_type, pattern_key);

create index if not exists experience_capsules_user_status_idx
  on public.experience_capsules (user_id, status);

alter table public.experience_capsules enable row level security;

drop policy if exists "capsules_select_own" on public.experience_capsules;
create policy "capsules_select_own"
  on public.experience_capsules for select
  using (auth.uid() = user_id);

-- Writes happen via the service role from the engine; service role bypasses
-- RLS, so no user-side INSERT/UPDATE policies are needed.

-- ---------------------------------------------------------------------------
-- intelligence_insights — surfaced recommendations
-- ---------------------------------------------------------------------------
create table if not exists public.intelligence_insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capsule_id uuid references public.experience_capsules(id) on delete set null,
  insight_type text not null,
  insight_key text not null,
  title text not null,
  description text not null,
  priority smallint not null default 3
    check (priority between 1 and 5),
  status text not null default 'pending'
    check (status in ('pending', 'acted_on', 'dismissed', 'expired')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  acted_on_at timestamptz,
  expires_at timestamptz
);

create unique index if not exists insights_user_key_idx
  on public.intelligence_insights (user_id, insight_key)
  where status = 'pending';

create index if not exists insights_user_status_idx
  on public.intelligence_insights (user_id, status, priority desc, created_at desc);

alter table public.intelligence_insights enable row level security;

drop policy if exists "insights_select_own" on public.intelligence_insights;
create policy "insights_select_own"
  on public.intelligence_insights for select
  using (auth.uid() = user_id);

-- Writes happen via the service role from the engine; service role bypasses
-- RLS, so no user-side INSERT/UPDATE policies are needed.

-- ---------------------------------------------------------------------------
-- system_health_log — internal self-monitoring
-- ---------------------------------------------------------------------------
create table if not exists public.system_health_log (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'analysis_run',
    'degradation_detected',
    'parameter_tuned',
    'rollback_triggered',
    'insight_generated',
    'capsule_promoted',
    'capsule_staled',
    'low_acceptance_rate'
  )),
  user_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists system_health_log_created_idx
  on public.system_health_log (created_at desc);

create index if not exists system_health_log_type_idx
  on public.system_health_log (event_type, created_at desc);

-- RLS: users may read their own health rows; writes are service-role only.
alter table public.system_health_log enable row level security;

drop policy if exists "Users can read own health logs" on public.system_health_log;
create policy "Users can read own health logs"
  on public.system_health_log for select
  using (auth.uid() = user_id);

