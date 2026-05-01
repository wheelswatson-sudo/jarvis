-- Migration 005 — security retrofit for the intelligence tables.
--
-- If 004_intelligence.sql was already applied to a Supabase project before
-- the security review landed, this migration brings that project into the
-- post-review state:
--
--   1. Enable RLS on system_health_log and add a SELECT-own policy.
--      (Originally created with no RLS — cross-tenant data was readable
--      via the anon key.)
--   2. Drop the user-side INSERT/UPDATE policies on experience_capsules
--      and intelligence_insights. These tables are written exclusively
--      by the engine via the service role, which bypasses RLS, so the
--      user-side write policies were dead code that widened the attack
--      surface.
--
-- Idempotent — safe to re-run, and safe to apply on top of either the
-- pre-fix or the post-fix version of 004.

-- ---------------------------------------------------------------------------
-- 1. system_health_log: enable RLS + SELECT-own
-- ---------------------------------------------------------------------------
alter table public.system_health_log enable row level security;

drop policy if exists "Users can read own health logs" on public.system_health_log;
create policy "Users can read own health logs"
  on public.system_health_log for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. experience_capsules: drop user-side write policies
-- ---------------------------------------------------------------------------
drop policy if exists "capsules_insert_own" on public.experience_capsules;
drop policy if exists "capsules_update_own" on public.experience_capsules;
drop policy if exists "Users can insert own capsules" on public.experience_capsules;
drop policy if exists "Users can update own capsules" on public.experience_capsules;

-- ---------------------------------------------------------------------------
-- 3. intelligence_insights: drop user-side write policies
-- ---------------------------------------------------------------------------
drop policy if exists "insights_insert_own" on public.intelligence_insights;
drop policy if exists "insights_update_own" on public.intelligence_insights;
drop policy if exists "Users can insert own insights" on public.intelligence_insights;
drop policy if exists "Users can update own insights" on public.intelligence_insights;
