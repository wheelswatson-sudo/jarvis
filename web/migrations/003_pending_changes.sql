-- Migration 003 — pending_changes table
--
-- Approval queue for contact field changes coming from external sync
-- sources (Google Contacts, Gmail, etc.). When a sync would conflict
-- with a value the user has manually edited, the change is parked here
-- as 'pending' instead of silently overwriting. The user reviews the
-- queue at /approvals and decides per-field. Approved changes are
-- applied to public.contacts; rejected changes are kept for audit.
-- Apply via the Supabase SQL editor.

create table if not exists public.pending_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  source text not null,
  field_name text not null,
  old_value text,
  new_value text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists pending_changes_user_status_idx
  on public.pending_changes (user_id, status);

create index if not exists pending_changes_contact_idx
  on public.pending_changes (contact_id);

alter table public.pending_changes enable row level security;

drop policy if exists "pending_changes_select_own" on public.pending_changes;
create policy "pending_changes_select_own"
  on public.pending_changes for select
  using (auth.uid() = user_id);

drop policy if exists "pending_changes_insert_own" on public.pending_changes;
create policy "pending_changes_insert_own"
  on public.pending_changes for insert
  with check (auth.uid() = user_id);

drop policy if exists "pending_changes_update_own" on public.pending_changes;
create policy "pending_changes_update_own"
  on public.pending_changes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "pending_changes_delete_own" on public.pending_changes;
create policy "pending_changes_delete_own"
  on public.pending_changes for delete
  using (auth.uid() = user_id);
