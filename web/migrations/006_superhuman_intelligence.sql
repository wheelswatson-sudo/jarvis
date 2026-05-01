-- Migration 006 — Superhuman intelligence layer
--
-- Adds:
--   contacts.personal_details   — JSONB (family, hobbies, career, life events)
--   contacts.relationship_score — REAL 0..1 (composite health score)
--   contacts.next_follow_up     — TIMESTAMPTZ (next reconnect target)
--   interactions.{key_points,action_items,follow_up_date,transcript_data,source,type}
--
-- Idempotent — safe to re-run. Apply via Supabase SQL editor (project
-- wsoxrooqlxaezkwogcfr).

-- ---------------------------------------------------------------------------
-- contacts — dossier columns
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists personal_details jsonb not null default '{}'::jsonb;

alter table public.contacts
  add column if not exists relationship_score real;

alter table public.contacts
  add column if not exists next_follow_up timestamptz;

create index if not exists contacts_next_follow_up_idx
  on public.contacts (user_id, next_follow_up)
  where next_follow_up is not null;

create index if not exists contacts_relationship_score_idx
  on public.contacts (user_id, relationship_score desc nulls last);

-- ---------------------------------------------------------------------------
-- interactions — create-or-upgrade
-- ---------------------------------------------------------------------------
create table if not exists public.interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  channel text,
  direction text check (direction in ('inbound', 'outbound')),
  summary text,
  body text,
  sentiment real,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.interactions
  add column if not exists type text;

alter table public.interactions
  add column if not exists key_points text[] not null default array[]::text[];

alter table public.interactions
  add column if not exists action_items jsonb not null default '[]'::jsonb;

alter table public.interactions
  add column if not exists follow_up_date timestamptz;

alter table public.interactions
  add column if not exists transcript_data jsonb;

alter table public.interactions
  add column if not exists source text;

create index if not exists interactions_user_occurred_idx
  on public.interactions (user_id, occurred_at desc);

create index if not exists interactions_contact_occurred_idx
  on public.interactions (contact_id, occurred_at desc)
  where contact_id is not null;

alter table public.interactions enable row level security;

drop policy if exists "interactions_select_own" on public.interactions;
create policy "interactions_select_own"
  on public.interactions for select
  using (auth.uid() = user_id);

drop policy if exists "interactions_insert_own" on public.interactions;
create policy "interactions_insert_own"
  on public.interactions for insert
  with check (auth.uid() = user_id);

drop policy if exists "interactions_update_own" on public.interactions;
create policy "interactions_update_own"
  on public.interactions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "interactions_delete_own" on public.interactions;
create policy "interactions_delete_own"
  on public.interactions for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- commitments — make sure RLS + helpful columns exist
-- ---------------------------------------------------------------------------
create table if not exists public.commitments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  description text not null,
  due_at timestamptz,
  status text not null default 'open'
    check (status in ('open', 'done', 'snoozed', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.commitments
  add column if not exists owner text default 'me'
    check (owner in ('me', 'them'));

alter table public.commitments
  add column if not exists interaction_id uuid references public.interactions(id) on delete set null;

alter table public.commitments
  add column if not exists notes text;

create index if not exists commitments_user_status_idx
  on public.commitments (user_id, status, due_at);

create index if not exists commitments_contact_idx
  on public.commitments (contact_id) where contact_id is not null;

alter table public.commitments enable row level security;

drop policy if exists "commitments_select_own" on public.commitments;
create policy "commitments_select_own"
  on public.commitments for select
  using (auth.uid() = user_id);

drop policy if exists "commitments_insert_own" on public.commitments;
create policy "commitments_insert_own"
  on public.commitments for insert
  with check (auth.uid() = user_id);

drop policy if exists "commitments_update_own" on public.commitments;
create policy "commitments_update_own"
  on public.commitments for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "commitments_delete_own" on public.commitments;
create policy "commitments_delete_own"
  on public.commitments for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- meeting_briefs — cached AI prep briefs
-- ---------------------------------------------------------------------------
create table if not exists public.meeting_briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  brief jsonb not null,
  generated_at timestamptz not null default now()
);

create index if not exists meeting_briefs_user_contact_idx
  on public.meeting_briefs (user_id, contact_id, generated_at desc);

alter table public.meeting_briefs enable row level security;

drop policy if exists "meeting_briefs_select_own" on public.meeting_briefs;
create policy "meeting_briefs_select_own"
  on public.meeting_briefs for select
  using (auth.uid() = user_id);

-- Writes happen via the service role from the brief generator.
