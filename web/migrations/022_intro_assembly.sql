-- Migration 022 — intro request assembly
--
-- Feature 15. Two pieces:
--
-- 1. `outbound_actions` — a generic queue for things AIEA wants to send on
--    the user's behalf (intro emails, follow-ups, suggested DMs). Distinct
--    from `approvals` (which is the sync-conflict gate) and from the
--    parallel-worktree `outbound_actions` that may land later — both
--    versions are guarded with CREATE TABLE IF NOT EXISTS plus ADD COLUMN
--    IF NOT EXISTS so they converge on the same shape.
--
--    `event_hash` is the dedup key (unique, nullable) — writers compute a
--    deterministic hash from the trigger context (e.g. `intro:<a>:<b>`)
--    so re-runs of detection logic don't pile up duplicate drafts.
--
-- 2. `commitments.commitment_type` — labels a commitment so the UI can
--    branch on it: 'intro' for pending intro opportunities surfaced from
--    natural-language detection, 'follow-up' for auto-created post-send
--    check-ins, 'general' for everything else (default).
--
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- outbound_actions
-- ---------------------------------------------------------------------------

create table if not exists public.outbound_actions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  contact_id        uuid references public.contacts(id) on delete set null,
  channel           text not null,
  recipient         text,
  subject           text,
  draft             text not null,
  context           text,
  status            text not null default 'draft'
    check (status in ('draft', 'queued', 'sent', 'cancelled', 'failed')),
  suggested_send_at timestamptz,
  sent_at           timestamptz,
  event_hash        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The columns may already exist if a parallel migration landed first.
-- Reapply with IF NOT EXISTS so this migration converges on the same shape.
alter table public.outbound_actions
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.outbound_actions
  add column if not exists contact_id uuid references public.contacts(id) on delete set null;
alter table public.outbound_actions
  add column if not exists channel text;
alter table public.outbound_actions
  add column if not exists recipient text;
alter table public.outbound_actions
  add column if not exists subject text;
alter table public.outbound_actions
  add column if not exists draft text;
alter table public.outbound_actions
  add column if not exists context text;
alter table public.outbound_actions
  add column if not exists status text default 'draft';
alter table public.outbound_actions
  add column if not exists suggested_send_at timestamptz;
alter table public.outbound_actions
  add column if not exists sent_at timestamptz;
alter table public.outbound_actions
  add column if not exists event_hash text;
alter table public.outbound_actions
  add column if not exists created_at timestamptz not null default now();
alter table public.outbound_actions
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists outbound_actions_event_hash_idx
  on public.outbound_actions (user_id, event_hash)
  where event_hash is not null;

create index if not exists outbound_actions_user_status_idx
  on public.outbound_actions (user_id, status, created_at desc);

create index if not exists outbound_actions_user_contact_idx
  on public.outbound_actions (user_id, contact_id, created_at desc)
  where contact_id is not null;

create or replace function public.touch_outbound_actions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists outbound_actions_touch_updated_at on public.outbound_actions;
create trigger outbound_actions_touch_updated_at
  before update on public.outbound_actions
  for each row execute function public.touch_outbound_actions_updated_at();

alter table public.outbound_actions enable row level security;

drop policy if exists "outbound_actions_owner_all" on public.outbound_actions;
create policy "outbound_actions_owner_all" on public.outbound_actions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- commitments.commitment_type
-- ---------------------------------------------------------------------------
-- Distinguishes intro opportunities and follow-up check-ins from generic
-- promises. Default 'general' so every existing row remains valid without
-- a backfill update.

alter table public.commitments
  add column if not exists commitment_type text not null default 'general'
    check (commitment_type in ('intro', 'follow-up', 'general'));

create index if not exists commitments_user_type_status_idx
  on public.commitments (user_id, commitment_type, status)
  where status = 'open';
