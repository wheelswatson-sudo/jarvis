---
name: pre-flight
description: Run before touching code in this repo. Two-minute checklist that loads project context (CLAUDE.md, AIEA_CONSIDER, MVP_GAPS), deploy state, git state, and known foot-guns (017 migration duplicate, CRON alignment, env vars, defect catalog). Use at the start of every code session so the session starts informed instead of rediscovering context cold.
---

# Pre-flight checklist

Read top-to-bottom. Skip any step whose file/command is missing — don't block on it. Total time budget: ~2 minutes.

## 1. Context (read these in order, stop early if a task is obviously scoped)

- [ ] `web/CLAUDE.md` (→ `@AGENTS.md`) — stack rules, conventions, what NOT to assume from training data
- [ ] `web/AIEA_CONSIDER.md` — prioritized backlog. **Check before building anything new** — don't duplicate or build unvalidated features
- [ ] `web/MVP_GAPS.md` — what blocks revenue. Stay focused on these unless the user explicitly asks otherwise

## 2. Repo state

```bash
git status --short
git log --oneline -5
git branch --show-current
```

Flag to the user if: uncommitted changes you didn't make, branch isn't what you'd expect, or last commit looks half-finished.

## 3. Deploy state

```bash
vercel ls --limit 1
```

If latest deploy is `● Error` or `● Building` for >10 min, surface this **before** writing new code — the user may want to fix the broken deploy first.

## 4. Known foot-guns (verify, don't assume)

- **Migration 017 is duplicated.** Both `017_analytics_events.sql` and `017_contacts_pipeline.sql` exist. New migrations must use `020+`. Confirm with `ls web/migrations/ | tail -5`.
- **CRON_SECRET / SMS_GATEWAY_WEBHOOK_SECRET** — env-var misalignment between Vercel and the iMessage/SMS bridges is a recurring 401 source. If touching cron/webhook code, check `vercel env ls` before debugging logic.
- **Vercel cron schedule** lives in `web/vercel.json`. If adding a route under `/api/cron/*`, the cron entry must exist there or it will never fire in production.
- **`web/CLAUDE.md` is a one-line `@AGENTS.md` import.** Edits to project-wide guidance go in `web/AGENTS.md`, not CLAUDE.md.

## 5. Defect catalog (if it exists)

```bash
test -f .auto-memory/feedback_defect_catalog.md && cat .auto-memory/feedback_defect_catalog.md
```

Catalog of recurring code-pattern defects. Skim before writing new code in a similar area — silently skip if the file doesn't exist yet.

## 6. Sanity check before first edit

Before the first `Edit`/`Write` call, confirm to yourself:

1. The task isn't already represented in `AIEA_CONSIDER.md` or `MVP_GAPS.md` with different scope.
2. You know which subdir owns the change (`web/`, `bin/`, `client/`, `lib/`, `hooks/`) — most user-facing app code is `web/`.
3. If the change touches DB schema, you've picked migration number `020+`.
4. If the change touches a cron or webhook route, the env vars and `vercel.json` entry are accounted for.

If any of those are unclear, ask the user one sharp question before proceeding rather than guessing.
