-- Migration 021 — drafts (pre-drafted reply queue)
--
-- The "draft replies on demand" surface: a user clicks "Draft reply" on an
-- unreplied-inbound or stalled-outbound forgotten loop, the LLM produces a
-- contextual reply, it lands here for review/edit before the user copies
-- it into Gmail (we don't have gmail.send scope; that's intentional).
--
-- Idempotent — safe to re-run.

create table if not exists public.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  -- The inbound (or last outbound) message that prompted the draft. NULL is
  -- valid: a manual draft tied to a contact with no specific message anchor.
  message_id uuid references public.messages(id) on delete set null,
  -- Why this draft exists. Drives UI grouping + analytics.
  trigger text not null check (trigger in ('forgotten_loop', 'manual', 'auto')),
  -- Reply content. Subject is optional — Gmail "Re: <previous>" handles most
  -- thread cases; we only set it for new threads.
  subject text,
  body text not null,
  -- Provenance for transparency. `reasoning` captures a short rationale the
  -- model emitted alongside the draft so the user can sanity-check the
  -- draft's frame ("matched their last sentence's tone, kept it short").
  model text,
  reasoning text,
  -- Lifecycle. 'sent' is informational — we don't actually send via API,
  -- the user marks it sent after copying to Gmail.
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'sent', 'discarded')),
  generated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists drafts_user_status_idx
  on public.drafts(user_id, status, generated_at desc);
create index if not exists drafts_user_message_idx
  on public.drafts(user_id, message_id);
create index if not exists drafts_user_contact_idx
  on public.drafts(user_id, contact_id);

-- updated_at trigger
create or replace function public.bump_drafts_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists drafts_set_updated_at on public.drafts;
create trigger drafts_set_updated_at
  before update on public.drafts
  for each row execute function public.bump_drafts_updated_at();

-- reviewed_at sync: stamped when status moves out of 'pending'.
create or replace function public.sync_drafts_reviewed_at()
returns trigger language plpgsql as $$
begin
  if new.status <> 'pending' and (old is null or old.status = 'pending') then
    if new.reviewed_at is null then
      new.reviewed_at := now();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists drafts_sync_reviewed_at on public.drafts;
create trigger drafts_sync_reviewed_at
  before insert or update on public.drafts
  for each row execute function public.sync_drafts_reviewed_at();

-- RLS — owner-only, no spoofable status transitions on insert.
alter table public.drafts enable row level security;

drop policy if exists "drafts_select_own" on public.drafts;
create policy "drafts_select_own"
  on public.drafts for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT: only as the calling user, only into 'pending'. Backend (service
-- role) bypasses RLS, so the generate endpoint can land any status it
-- needs for diagnostics.
drop policy if exists "drafts_insert_own_pending" on public.drafts;
create policy "drafts_insert_own_pending"
  on public.drafts for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and status = 'pending'
  );

drop policy if exists "drafts_update_own" on public.drafts;
create policy "drafts_update_own"
  on public.drafts for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "drafts_delete_own" on public.drafts;
create policy "drafts_delete_own"
  on public.drafts for delete
  to authenticated
  using (auth.uid() = user_id);
