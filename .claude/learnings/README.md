# .claude/learnings/

Per-task learning files for Claude Code sessions in this repo. Each file
captures what worked, what was slow, and one concrete change to try next
time. Read at start-of-task; written at end-of-task.

Protocol lives in `.claude/skills/self-improvement/SKILL.md`. This README
is just the directory contract.

## File naming

```
YYYY-MM-DD-HHMM-{kebab-slug}.md
```

Examples: `2026-05-12-0815-dedupe-daily-actions.md`, `2026-05-12-1030-pipeline-stage-refactor.md`

## Format

Aim for **~10 lines of body**. Frontmatter is structured; body is prose.

```markdown
---
task: <one line — what the user asked for>
date: 2026-05-12
turns: <N assistant turns>
tool_calls: <N total tool calls>
wasted: <N wasted tool calls>
preflight_fired: <true|false>
---

what_worked: <one specific thing, not "the plan was good">
what_was_slow: <one bottleneck — "5 sequential Reads that could have been parallel", not "could be faster">
process_improvement: <one concrete change for next similar task>

patterns:
  batchable: <yes/no — what could have been parallel>
  rediscovery: <yes/no — what was already in memory>
  already_queued: <yes/no — was it on AIEA_CONSIDER.md>
  catalog_miss: <yes/no — known defect type not consulted>

score:
  turns_to_first_action: <N>
  wasted_tool_calls: <N>
  shipped: <true|false>
  scope_creep: <true|false>

next: <promote-to-memory | promote-to-catalog | keep-local>
```

## When to READ

At the start of any non-trivial task — read the last 3 files:

```bash
ls -t .claude/learnings/*.md 2>/dev/null | grep -vE '(README|TEMPLATE)\.md' | head -3
```

**Optional:** drop this snippet into `~/.claude/hooks/session-brief.sh` to
surface recent learnings in the session brief automatically:

```bash
LEARNINGS_DIR="$PWD/.claude/learnings"
if [ -d "$LEARNINGS_DIR" ]; then
  echo "## 📓 Recent learnings (last 3)"
  ls -t "$LEARNINGS_DIR"/*.md 2>/dev/null | grep -vE '(README|TEMPLATE)\.md' | head -3 | while read f; do
    echo "- **$(basename "$f" .md)** — $(grep -m1 '^task:' "$f" | sed 's/^task: //')"
  done
fi
```

## When to WRITE

After any task hitting the trigger thresholds in the skill (≥3 files edited,
≥8 tool calls, explicit /reflect, or mid-flight error).

**Budget: 2 minutes.** If you're going longer, stop and write less.

## What does NOT go here

| Type | Goes to |
|---|---|
| Recurring rules / corrections | `~/.claude/projects/*/memory/feedback_*.md` (via promotion) |
| Defects / known bugs | `AIEA_CONSIDER.md` (via promotion) |
| Architecture decisions | `~/.claude/decisions/` (via `/decision-log`) |
| Session conversation summaries | `consolidate-memory` skill, not here |
| In-progress task state | `TodoWrite` / plan mode, not here |

## Pruning

Learnings older than 90 days that never got promoted should be reviewed and
deleted — they were tactical, not durable. The directory should not grow
unbounded; ~30-50 active files is the sweet spot.

```bash
find .claude/learnings -name "*.md" -mtime +90 -not -name 'README.md' -not -name 'TEMPLATE.md'
```
