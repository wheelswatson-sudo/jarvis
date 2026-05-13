-- Migration 020 — pipeline tracking columns on contacts
--
-- Turns AIEA from a relationship monitor into a relationship manager: every
-- tracked person can now sit in a stage of the user's outreach pipeline
-- (lead → warm → active → committed → closed, plus a dormant escape hatch).
-- pipeline_notes is freeform context the user types directly on the contact
-- detail page; pipeline_updated_at is auto-maintained by a trigger so we
-- can sort by "most recently moved" on the kanban board.
--
-- Idempotent — safe to re-run. The new columns inherit the existing
-- contacts_owner_all RLS policy (row-scoped, applies to every column),
-- so no new policy is needed. The trigger only fires when the pipeline
-- fields actually change so unrelated updates (e.g. last_interaction_at
-- bumps from sync jobs) don't churn pipeline_updated_at.

alter table public.contacts
  add column if not exists pipeline_stage text
    check (pipeline_stage is null or pipeline_stage in (
      'lead', 'warm', 'active', 'committed', 'closed', 'dormant'
    ));

alter table public.contacts
  add column if not exists pipeline_notes text;

alter table public.contacts
  add column if not exists pipeline_updated_at timestamptz;

create index if not exists contacts_user_pipeline_stage_idx
  on public.contacts (user_id, pipeline_stage)
  where pipeline_stage is not null;

create or replace function public.touch_contacts_pipeline_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.pipeline_stage is distinct from old.pipeline_stage
     or new.pipeline_notes is distinct from old.pipeline_notes then
    new.pipeline_updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists contacts_touch_pipeline_updated_at on public.contacts;
create trigger contacts_touch_pipeline_updated_at
  before update on public.contacts
  for each row execute function public.touch_contacts_pipeline_updated_at();
