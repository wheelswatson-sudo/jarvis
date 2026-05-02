-- Migration 009 — defensive backfill for intelligence_insights.priority
--
-- Migration 004 created intelligence_insights with a `priority smallint` column.
-- Some environments were apparently provisioned from a pre-priority snapshot of
-- the table (the dashboard surfaced
-- `column intelligence_insights.priority does not exist` from the
-- /api/intelligence/insights GET handler, which orders by priority).
--
-- 004's `create table if not exists` is a no-op when the table is present, so
-- adding the column there wouldn't help — this migration explicitly
-- `add column if not exists` and recreates the dependent index.
--
-- Idempotent — safe to re-run. Apply via Supabase SQL editor.

alter table public.intelligence_insights
  add column if not exists priority smallint not null default 3;

-- Re-assert the check constraint. `add constraint if not exists` doesn't exist
-- in Postgres, so guard it with a catalog lookup.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'intelligence_insights_priority_check'
      and conrelid = 'public.intelligence_insights'::regclass
  ) then
    alter table public.intelligence_insights
      add constraint intelligence_insights_priority_check
      check (priority between 1 and 5);
  end if;
end$$;

-- Index is sorted by priority desc — recreate so existing rows are included.
create index if not exists insights_user_status_idx
  on public.intelligence_insights (user_id, status, priority desc, created_at desc);
