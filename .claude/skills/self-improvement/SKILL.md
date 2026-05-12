---
name: self-improvement
description: >
  Post-task reflection protocol — measure execution, persist a ~10-line learning
  file under `.claude/learnings/`, and read recent learnings so future sessions
  don't repeat the same mistakes. Designed for LOW OVERHEAD: under 2 minutes of
  reflection per task. Compounding value lives on the READ side, not the WRITE
  side.
  TRIGGER after completing a non-trivial code task (≥3 file edits, OR ≥8 tool
  calls, OR explicit "/reflect" / "what would you do differently", OR the task
  hit an unexpected error mid-flight). Also TRIGGER at start-of-task to read
  the last 3 learning files before planning.
  SKIP for trivial reads/answers (≤2 tool calls, no edits), for tasks already
  inside the loop (don't recursively reflect on a reflection), and when
  `.claude/learnings/` doesn't exist (means project hasn't opted in).
---

# Self-Improvement Skill

## Purpose

Close the loop on Claude Code sessions. Each non-trivial task ends with a brief
reflection capturing what worked, what was slow, and one concrete process
change. Future sessions read recent learnings at start-of-task so the same
mistakes aren't paid for twice.

Compounding value lives on the READ side. Reflection budget is **2 minutes**.
If it takes longer, the entry is too long.

## Bootstrap — start-of-task READ (under 30 seconds)

Before planning any non-trivial task, read the last 3 files in
`.claude/learnings/` (by mtime, excluding `README.md` and `TEMPLATE.md`):

```bash
ls -t .claude/learnings/*.md 2>/dev/null | grep -vE '(README|TEMPLATE)\.md' | head -3
```

For each file, scan for:
- A learning that names this exact task type or code path
- A `process_improvement` line that applies to the current plan
- A `next: promote-to-catalog` entry whose defect matches what you're touching

If one applies, restate it in **one sentence** as part of your plan ("Last
similar task noted that X — applying that here."). If none apply, say so in
one sentence and move on. That's the entire read-side ritual.

## Trigger heuristic — when to write

Run the post-task reflection when ANY of:
- ≥3 distinct files edited, OR
- ≥8 tool calls in the task, OR
- The user said "/reflect", "what would you do differently", or "post-mortem", OR
- The task hit an unexpected error mid-flight (silent failure, retry loop, wrong tool choice)

**Skip** when:
- The task was Q&A or a single-file edit (≤2 tool calls)
- A reflection already ran this session for this task
- The current task IS a reflection (no recursive self-reflection)

> Threshold note: 3/8 are sensible defaults but should be tuned to your actual
> task distribution. See "Calibration" section at bottom.

## Post-task reflection (under 2 minutes total)

### Step 1 — Measure execution (30 sec)

From the just-completed task, count:

- **Tool calls total** — Read + Edit + Write + Bash + Grep + Agent + ...
- **Wasted tool calls** — a tool call is wasted if it meets any of:
  - A Read whose content was not referenced by any subsequent Edit/Write/decision
  - A Grep that returned no relevant matches
  - A Bash call that errored and was retried with the same intent (not a different fix)
  - A subagent spawn whose result was ignored or duplicated work the main thread also did
- **Assistant turns** — proxy for wall time
- **Pre-flight fired?** Did reading recent learnings actually change the plan? (true/false)

### Step 2 — Identify patterns (30 sec)

Answer exactly four questions, one line each. Skip any that don't apply — don't fabricate.

1. **Batchable?** Was there a 2+ tool sequence that could have been one parallel call?
2. **Rediscovery?** Did the session re-derive something already in `~/.claude/projects/*/memory/`?
3. **Already queued?** Was this work already on `AIEA_CONSIDER.md` or another backlog? Who owned it?
4. **Catalog miss?** Did the session hit a defect type already known but not consulted?

### Step 3 — Persist learning (60 sec)

Write to `.claude/learnings/YYYY-MM-DD-HHMM-{slug}.md` using the template in
`.claude/learnings/README.md`. Stay around **10 lines**. Discipline beats
exhaustiveness — a 30-line entry won't get read by future sessions.

Each entry's final `next:` field decides promotion:
- `promote-to-memory` → add as a `feedback_*` memory in `~/.claude/projects/*/memory/` next session
- `promote-to-catalog` → add to `AIEA_CONSIDER.md` (defect or missing capability)
- `keep-local` → stays in `.claude/learnings/` only; useful only if it recurs

Promotion is a **deliberate** write, not a default. Most entries should stay local.

## Scoring rubric

Embedded in each learning file as the `score:` block:

```yaml
score:
  turns_to_first_action: <N>     # turns from user message → first non-Read tool call (lower better)
  wasted_tool_calls: <N>          # target: 0
  shipped: <true|false>           # did the task deliver the asked outcome? (binary)
  scope_creep: <true|false>       # did we touch anything not on the priority list?
```

**How to read scores over time:**
- `turns_to_first_action` trending down across similar tasks = pre-flight is working
- `wasted_tool_calls > 0` in 3 consecutive entries = a defect; promote to catalog
- `shipped: false` is the most informative entry — those are where capability gaps live
- `scope_creep: true` in a "ship feature X" task = caller drift; flag in next pre-flight

## Anti-patterns

- ❌ Writing a 50-line reflection because the task felt important. Length ≠ insight.
- ❌ Generic improvements ("be more careful", "plan better"). Use specifics from the template's fields or skip them.
- ❌ Reading >5 learning files at start. Diminishing returns; the 3 most recent carry the signal.
- ❌ Reflecting on a reflection (recursive loop).
- ❌ Promoting every entry to memory. The index gets noisy; trust degrades.

## Failure mode

If reflection itself takes >2 minutes, **abort** and write a one-line entry:

```
task: <X>. slow_step: <Y>. will_revisit_if_recurs: true.
```

Then move on. Overhead kills the system faster than incompleteness does.

## Calibration

After ~20 learning files exist, audit:
- What % of tasks hit the trigger? If <30%, threshold is too high. If >80%, too low.
- What % of `next:` fields are `keep-local`? If 100%, you're not finding generalizable patterns. If <50%, you're over-promoting.

Tune the heuristic in this file's frontmatter. The numbers (3 files / 8 tool calls)
are guesses until calibrated against real distribution.
