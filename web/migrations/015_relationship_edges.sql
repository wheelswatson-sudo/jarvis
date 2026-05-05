-- Migration 015 — relationship_edges (AIEA Layer 1: Observation)
--
-- Directed weighted relationship graph. One row per (user, contact) where
-- there has been any interaction in the last 90 days. Recomputed daily from
-- messages + calendar_events + interactions. The daily-briefing LLM and the
-- per-contact meeting prep both read these rows to ground their reasoning
-- in concrete relationship signals (strength, trend, reciprocity).
--
-- Apply via the Supabase SQL editor (project: wsoxrooqlxaezkwogcfr).
-- Idempotent — safe to re-run.

create table if not exists public.relationship_edges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  strength numeric(4,3) not null default 0
    check (strength >= 0 and strength <= 1),
  trend text not null default 'stable'
    check (trend in ('warming', 'stable', 'cooling', 'dormant')),
  last_interaction_at timestamptz,
  interaction_count_30d integer not null default 0
    check (interaction_count_30d >= 0),
  interaction_count_90d integer not null default 0
    check (interaction_count_90d >= 0),
  reciprocity_score numeric(4,3)
    check (reciprocity_score is null or (reciprocity_score >= 0 and reciprocity_score <= 1)),
  avg_response_time_hours numeric,
  initiated_by_me_pct numeric(4,3)
    check (initiated_by_me_pct is null or (initiated_by_me_pct >= 0 and initiated_by_me_pct <= 1)),
  last_computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, contact_id)
);

create index if not exists relationship_edges_user_strength_idx
  on public.relationship_edges (user_id, strength desc);

create index if not exists relationship_edges_user_trend_idx
  on public.relationship_edges (user_id, trend);

create index if not exists relationship_edges_contact_idx
  on public.relationship_edges (contact_id);

create or replace function public.touch_relationship_edges_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists relationship_edges_touch_updated_at on public.relationship_edges;
create trigger relationship_edges_touch_updated_at
  before update on public.relationship_edges
  for each row execute function public.touch_relationship_edges_updated_at();

alter table public.relationship_edges enable row level security;

drop policy if exists "relationship_edges_select_own" on public.relationship_edges;
create policy "relationship_edges_select_own"
  on public.relationship_edges for select
  using (auth.uid() = user_id);

-- Writes happen via the service role from the daily compute job; service
-- role bypasses RLS so no user-side INSERT/UPDATE policies are needed.
