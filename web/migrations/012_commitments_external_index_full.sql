-- Migration 012 — replace partial unique index with full unique index
--
-- Migration 011 created a partial unique index on commitments
-- (user_id, source, external_id) WHERE external_id IS NOT NULL. Postgres
-- only accepts a partial index as an ON CONFLICT target if the statement
-- repeats the same WHERE predicate, which Supabase's REST upsert cannot
-- emit. Result: every Google Tasks sync upsert blew up with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- A regular (non-partial) unique index works the same in practice — Postgres
-- treats NULLs as distinct under the default NULLS DISTINCT semantics, so
-- legacy manual rows with NULL source/external_id still coexist freely.
--
-- Apply via the Supabase SQL editor (project: wsoxrooqlxaezkwogcfr).
-- Idempotent — safe to re-run.

drop index if exists public.commitments_user_source_external_idx;

create unique index if not exists commitments_user_source_external_idx
  on public.commitments (user_id, source, external_id);
