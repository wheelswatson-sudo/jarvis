-- Migration 000 — base schema for `contacts` and `messages`
--
-- These tables exist in production but were never captured in this
-- migrations directory. Every later migration ALTERs them as if they
-- existed, but a fresh deploy (staging spin-up, new dev environment) has
-- no way to reach the prod schema. This migration baseline-creates them
-- so 003+ can layer on cleanly.
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS. Safe to re-run on
-- prod; safe to apply on a fresh database.
--
-- Ordering note: this file is named 000 so it runs before everything
-- else when migrations are applied alphabetically. The downstream files
-- already use `add column if not exists` so re-applying them after this
-- baseline is a no-op for prod and adds the missing pieces for a fresh
-- DB.

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------
-- One row per person the user tracks. Columns added by later migrations
-- (006_superhuman_intelligence, 008_intelligence_metrics) are duplicated
-- here with IF NOT EXISTS so this file alone can recreate the prod shape.

create table if not exists public.contacts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  -- Identity
  first_name      text,
  last_name       text,
  email           text,
  phone           text,

  -- Professional
  company         text,
  title           text,
  linkedin        text,

  -- Manual segmentation
  tier            smallint check (tier in (1, 2, 3)),
  tags            text[],

  -- Ranking signals (legacy, hand-tuned)
  ltv_estimate    numeric,
  half_life_days  integer,
  sentiment_slope real,

  -- Computed metrics (also re-declared in 008 with IF NOT EXISTS)
  sentiment_trajectory real,
  reciprocity_ratio    real,
  metrics_computed_at  timestamptz,

  -- Lifecycle
  last_interaction_at timestamptz,

  -- Schema-grounded relationship memory (also in 006 with IF NOT EXISTS)
  personal_details    jsonb not null default '{}'::jsonb,
  relationship_score  real,
  next_follow_up      timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists contacts_user_id_idx
  on public.contacts (user_id);

create index if not exists contacts_user_email_idx
  on public.contacts (user_id, lower(email))
  where email is not null;

create index if not exists contacts_user_phone_idx
  on public.contacts (user_id, phone)
  where phone is not null;

create index if not exists contacts_last_interaction_idx
  on public.contacts (user_id, last_interaction_at desc nulls last);

alter table public.contacts enable row level security;

drop policy if exists "contacts_owner_all" on public.contacts;
create policy "contacts_owner_all" on public.contacts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
-- Unified inbox across channels. Every sync pipeline writes here:
-- gmail-sync (channel='email'), imessage-sync (channel='imessage').
-- Dedup is enforced by the unique index on
-- (user_id, channel, external_id) — without it the on-conflict upserts
-- in every sync helper degrade to plain inserts and create duplicates
-- on every re-run.

create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  contact_id   uuid references public.contacts(id) on delete set null,

  -- Channel + provider id
  channel      text not null check (channel in ('email', 'imessage', 'sms')),
  external_id  text not null,
  thread_id    text,
  external_url text,

  -- Direction + parties
  direction    text not null check (direction in ('inbound', 'outbound')),
  sender       text,
  recipient    text,

  -- Content
  subject      text,
  body         text,
  snippet      text,

  -- UI state
  is_read      boolean not null default false,
  is_starred   boolean not null default false,
  is_archived  boolean not null default false,

  sent_at      timestamptz not null,
  created_at   timestamptz not null default now()
);

-- Single dedup contract every sync upsert relies on — onConflict:
-- 'user_id,channel,external_id'. Must remain unique.
create unique index if not exists messages_user_channel_external_idx
  on public.messages (user_id, channel, external_id);

create index if not exists messages_user_sent_at_idx
  on public.messages (user_id, sent_at desc);

create index if not exists messages_user_contact_idx
  on public.messages (user_id, contact_id, sent_at desc)
  where contact_id is not null;

create index if not exists messages_user_thread_idx
  on public.messages (user_id, thread_id, sent_at desc)
  where thread_id is not null;

alter table public.messages enable row level security;

drop policy if exists "messages_owner_all" on public.messages;
create policy "messages_owner_all" on public.messages
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
