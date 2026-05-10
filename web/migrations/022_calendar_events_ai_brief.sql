-- Migration 022 — calendar_events.ai_brief
--
-- LLM-generated meeting brief, stored 1:1 on the calendar_events row so it
-- auto-deletes when the event is canceled/removed and we don't need a join
-- on the read path. Generated lazily by the daily-sync cron for upcoming
-- events with at least one matched-contact attendee.
--
-- Shape:
--   {
--     "context":   "1-2 sentences setting the scene (who, where this stands)",
--     "why_now":   "why this meeting matters at this moment",
--     "open_with": "suggested opener / first move",
--     "watch":     ["thing 1 to listen for", "risk 2 to avoid"],
--     "goal":      "user's likely goal for this meeting",
--     "model":     "claude-sonnet-4-6"
--   }
--
-- A brief is regenerated when ai_brief_generated_at is older than 24h, or
-- when the matched contact has new activity since generation.

alter table public.calendar_events
  add column if not exists ai_brief jsonb,
  add column if not exists ai_brief_generated_at timestamptz;

-- Index used by the cron's "what needs a fresh brief?" query.
create index if not exists calendar_events_brief_freshness_idx
  on public.calendar_events (user_id, start_at)
  where ai_brief_generated_at is null or ai_brief is null;
