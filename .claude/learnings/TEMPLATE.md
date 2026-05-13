---
task: <one line — what the user asked for>
date: YYYY-MM-DD
turns: 0
tool_calls: 0
wasted: 0
preflight_fired: false
---

what_worked: <one specific thing>
what_was_slow: <one specific bottleneck>
process_improvement: <one concrete change>

patterns:
  batchable: no
  rediscovery: no
  already_queued: no
  catalog_miss: no

score:
  turns_to_first_action: 0
  wasted_tool_calls: 0
  shipped: true
  scope_creep: false

next: keep-local
