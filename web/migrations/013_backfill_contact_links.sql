-- Migration 013 — backfill contact_id on calendar_events and messages
--
-- Both tables capture contact_id at insert time by matching the attendee /
-- counterparty email against contacts.email. Rows that landed before the
-- corresponding contact existed (or where casing diverged) carry NULL,
-- which means the contact profile page misses them entirely.
--
-- This pass walks every NULL row and, for each user, assigns contact_id
-- based on the lowercased contacts.email lookup.
--
--   calendar_events — pull the first non-self attendee email out of the
--     attendees JSONB and join to contacts.
--   messages — use sender (when inbound) or recipient (when outbound).
--
-- Apply via the Supabase SQL editor (project: wsoxrooqlxaezkwogcfr).
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- calendar_events
-- ---------------------------------------------------------------------------
with attendee_emails as (
  select
    ce.id as event_id,
    ce.user_id,
    lower(trim(att->>'email')) as email
  from public.calendar_events ce
  cross join lateral jsonb_array_elements(coalesce(ce.attendees, '[]'::jsonb)) as att
  where ce.contact_id is null
    and att ? 'email'
    and att->>'email' is not null
),
ranked as (
  select
    ae.event_id,
    ae.user_id,
    c.id as contact_id,
    row_number() over (
      partition by ae.event_id
      order by c.updated_at desc nulls last, c.id
    ) as rn
  from attendee_emails ae
  join public.contacts c
    on c.user_id = ae.user_id
   and lower(c.email) = ae.email
   and c.email is not null
)
update public.calendar_events ce
set contact_id = r.contact_id
from ranked r
where r.event_id = ce.id and r.rn = 1;

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
-- Strip "Name <email>" wrappers when present.
with derived as (
  select
    m.id as message_id,
    m.user_id,
    lower(trim(
      coalesce(
        substring(
          (case when m.direction = 'outbound' then m.recipient else m.sender end)
          from '<([^>]+)>'
        ),
        case when m.direction = 'outbound' then m.recipient else m.sender end
      )
    )) as email
  from public.messages m
  where m.contact_id is null
),
ranked as (
  select
    d.message_id,
    c.id as contact_id,
    row_number() over (
      partition by d.message_id
      order by c.updated_at desc nulls last, c.id
    ) as rn
  from derived d
  join public.contacts c
    on c.user_id = d.user_id
   and lower(c.email) = d.email
   and c.email is not null
)
update public.messages m
set contact_id = r.contact_id
from ranked r
where r.message_id = m.id and r.rn = 1;

-- ---------------------------------------------------------------------------
-- Normalize stored contacts.email to lowercase. Future inserts already do
-- this, but legacy rows from CSV / vCard imports may have mixed case which
-- causes the joins above (and live sync paths) to miss matches.
-- ---------------------------------------------------------------------------
update public.contacts
set email = lower(email)
where email is not null and email <> lower(email);
