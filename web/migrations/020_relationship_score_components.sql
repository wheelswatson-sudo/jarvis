-- Migration 020 — relationship_score_components
--
-- The composite relationship_score is a 0-1 number that's hard to act on.
-- A user looking at "62%" can't tell whether to email, follow up on a
-- commitment, or just give the relationship time. We already compute the
-- underlying signals in /api/contacts/compute-scores (recency, frequency,
-- sentiment, follow_through) but throw them away after collapsing into
-- the geometric mean.
--
-- This column persists those signals so the UI can render a click-through
-- breakdown ("recency 78%, frequency 25%, …") and tell the user which
-- lever to pull. JSON shape — every field is optional and 0-1:
--
--   {
--     "recency":        0.82,        -- exp-decay over days since last contact
--     "frequency":      0.31,        -- emails(30d) normalised against your max
--     "sentiment":      0.64,        -- avg sentiment trajectory remapped to 0-1
--     "follow_through": 1.00,        -- commitment completion ratio
--     "computed_at":    "2026-05-09T19:30:00Z"
--   }
--
-- A signal is omitted (null) when there's no underlying data — same rule the
-- geometric-mean uses to skip components — so UI must tolerate missing keys.

alter table public.contacts
  add column if not exists relationship_score_components jsonb;

comment on column public.contacts.relationship_score_components is
  'Per-component breakdown of relationship_score. Keys: recency, frequency, sentiment, follow_through (each 0-1, nullable), plus computed_at.';
