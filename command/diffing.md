---
description: Start, run, or wrap up a diffing human-AI review over local git changes or a GitHub PR.
agent: smart
---

Use the `diffing` skill (loaded from `~/.agents/skills/diffing/`) to route `$ARGUMENTS` to the strongest available diffing surface — prefer the `diffing` MCP server (tools are auto-allowed), then the `diffing` CLI, then the offline workflow.

Route by intent:
- no args / `start` / `review` → `diffing-start-review`: launch or reopen the diffing UI for the current repo and hand it to the human.
- `comments` / `handoff` / `finish` → `diffing-finish-review`: wait for the human's "Send to agent", then apply requested edits, answer questions, and resolve threads.
- `plan <path>` → `diffing-plan-review`: submit the plan at <path> for human approval and obey the verdict before touching code.
- `pr <number|url>` → read with `diffing-pr-read`; if the user asks to address feedback, use `diffing-pr-address` (do not push or mutate GitHub without explicit authorization).
- `status` → call `review_session_status` (MCP) or `diffing url` to report whether a review server is running and what repo it serves.

Always: AGENTS.md in the diffing repo is the source of truth for the CLI/MCP contract; consult it via the `diffing` reference. Never write plans, notes, or scratch files into the consumer working tree — keep agent working files under `~/.diffing/`.