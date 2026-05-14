-- Migration 025 — relationship_score_snapshots
--
-- The composite + component scores in `contacts.relationship_score_*` are a
-- *current* snapshot. They get overwritten every time the cron runs, so we
-- can't detect "this relationship is cooling fast" — only "this relationship
-- is currently cool." That's a half-answer; the EA value is in the *delta*.
--
-- This table appends a row per contact per compute pass so we can ask:
--
--   "What was Sarah's sentiment 14d ago vs today?"  → cooled 0.72 → 0.41
--   "Whose composite dropped most this week?"        → top-N watch list
--
-- One row per (user_id, contact_id, computed_at). The compute-scores job
-- writes a batch insert after the contact rows are updated, so the snapshot
-- table is the authoritative history and the contacts column is just a
-- denormalized "latest" mirror.
--
-- Storage: at ~5k contacts × daily cron = ~1.8M rows/yr/user. Each row is
-- tiny (5 numerics + ts + 2 uuids ≈ 80 bytes). Pruning rule TBD; for now we
-- keep everything so we can backfill smarter analytics later.

create table if not exists public.relationship_score_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  composite numeric(5, 4),
  recency numeric(5, 4),
  frequency numeric(5, 4),
  sentiment numeric(5, 4),
  follow_through numeric(5, 4),
  computed_at timestamptz not null default now()
);

-- Primary read pattern: "give me the last N snapshots for a user, optionally
-- filtered to a contact, ordered newest-first." Compound index covers both
-- the per-contact and per-user cases.
create index if not exists relationship_score_snapshots_user_contact_time_idx
  on public.relationship_score_snapshots (user_id, contact_id, computed_at desc);

create index if not exists relationship_score_snapshots_user_time_idx
  on public.relationship_score_snapshots (user_id, computed_at desc);

alter table public.relationship_score_snapshots enable row level security;

drop policy if exists "users read own snapshots"
  on public.relationship_score_snapshots;
create policy "users read own snapshots"
  on public.relationship_score_snapshots
  for select
  using (auth.uid() = user_id);

-- Writes are service-role only (the compute-scores job runs with the service
-- key). No INSERT/UPDATE/DELETE policies for end-users — auth.uid() can't
-- write rows here, which is what we want.

comment on table public.relationship_score_snapshots is
  'Append-only history of per-contact relationship scores. Written by the compute-scores job after each cron pass. Used to detect sentiment shifts and composite trends.';
