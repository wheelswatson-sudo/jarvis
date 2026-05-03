-- Migration 011 — commitments.source + commitments.external_id
--
-- Adds dedup metadata so we can mirror Google Tasks (and any future
-- external system) into the commitments table without creating duplicates
-- on re-sync.
--
--   source       — short tag for the origin system, e.g. 'google_tasks',
--                  'gmail_extract', 'manual'.
--   external_id  — provider-side stable id (Google Tasks task id).
--
-- Apply via the Supabase SQL editor (project: wsoxrooqlxaezkwogcfr).
-- Idempotent — safe to re-run.

alter table public.commitments
  add column if not exists source text;

alter table public.commitments
  add column if not exists external_id text;

create unique index if not exists commitments_user_source_external_idx
  on public.commitments (user_id, source, external_id)
  where external_id is not null;
