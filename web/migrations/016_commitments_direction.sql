-- Migration 016 — commitments.direction column
--
-- Every writer to `commitments` has been setting `direction` ('me' | 'them')
-- alongside `owner` for months — gmail-sync, tasks-sync, imessage-sync,
-- transcripts/scan, and the manual interactions and gmail/sync routes.
-- The column was added out-of-band in production but never landed in the
-- migrations directory, so a fresh deploy has no way to reach the prod
-- schema. This migration captures it.
--
-- The column is currently a 1:1 mirror of `owner`; future work may
-- legitimately diverge them (e.g. a contact-owned commitment the user
-- agreed to track on someone else's behalf). Keeping it as a separate
-- column rather than dropping it preserves that flexibility.
--
-- Idempotent — safe to re-run. Uses ADD COLUMN IF NOT EXISTS, then
-- backfills NULLs from `owner` so the NOT NULL constraint can be added
-- afterward without breaking existing rows.

-- Add column with default first so existing rows get a value.
ALTER TABLE public.commitments
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'me'
    CHECK (direction IN ('me', 'them'));

-- Backfill from owner where this is the first time the column lands.
-- Safe even on re-run since rows already mirror owner.
UPDATE public.commitments
   SET direction = owner
 WHERE direction <> owner
   AND owner IN ('me', 'them');
