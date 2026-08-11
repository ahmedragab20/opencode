# opencode — Personal AI Engineering System

Personal configuration for [opencode](https://opencode.ai), built around a simple, reliable two-model architecture with dual primary leads.

## Architecture — Smart Leads, Workers Follow

Two primary leads share the same routing and worker delegation; only the reasoning model differs:

- **`smart`** (default) — DeepSeek V4 Flash via `opencode-go`
- **`cursor`** (opt-in) — Cursor subscription via `cursor/*` (configured model; not fixed to one vendor)

```
User → smart (default) or cursor (opt-in) — the lead. Plans, implements, verifies, reviews.
  ├─ Chores → Flash workers (DeepSeek V4 Flash Free): tests, lint, docs, git,
  │           worker, memory, terminal-reader, log-reader, diff-reader
  │           → each hands its result back to the lead
  │           → if a free worker is down, retry once with its *-paid twin
  │             (DeepSeek V4 Flash, opencode-go) before the lead does it itself
  ├─ Images (smart only) → vision (MiMo V2.5 Free) → vision-paid (MiMo V2.5) fallback
  └─ Images (cursor) → lead model's native vision when available (no vision subagent)
```

The lead owns every request end to end. It does the reasoning and substantive implementation itself and delegates only mechanical chores to cheap Flash workers, which follow its instructions and hand results back. Each free worker has a `*-paid` twin (same role, paid DeepSeek V4 Flash) for one retry when the free tier is unavailable. **Smart** has no vision, so its images go to the `vision` agent (with `vision-paid` as fallback). **Cursor** uses the configured Cursor model's native vision when available and must not call `vision` / `vision-paid`.

> **Accuracy overrides cost.** Never choose a cheaper path if it increases the chance of incorrect implementation, unsafe command, or data loss.

## Switching leads

| Action | Command / gesture |
|--------|-------------------|
| Start TUI with Cursor | `opencode --agent cursor` |
| Cycle agents in TUI | Tab |
| One-shot run with Cursor | `opencode run --agent cursor` |

Default remains `smart`. After config or plugin changes, restart opencode if the new agent or provider does not appear.

## Cursor auth

After the `cursor-oauth-opencode` plugin is installed, authenticate once:

```bash
opencode auth login --provider cursor
```

Prefer native `cursor/*` models and tools when this lead is active. Change the lead model anytime via `agent.cursor.model` in `opencode.jsonc` (and the matching frontmatter in `agent/cursor.md`); it is not locked to a specific Cursor catalog entry.

## Agents

| Agent | Model | Mode | Role |
|-------|-------|------|------|
| `smart` ★ | `opencode-go/deepseek-v4-flash` | primary | Smart lead (default): plans, implements, verifies, reviews; delegates chores + images |
| `cursor` | `cursor/*` (see `agent.cursor.model`) | primary | Cursor lead (opt-in): same routing as Smart; subscription reasoning; native vision when the model supports it; delegates chores |
| `worker` | `opencode/deepseek-v4-flash-free` | subagent | Mechanical boilerplate, CRUD, mocks, simple refactors |
| `worker-paid` | `opencode-go/deepseek-v4-flash` | subagent | Paid fallback for `worker` |
| `tests` | `opencode/deepseek-v4-flash-free` | subagent | Tests, snapshots, fixtures, mocks |
| `tests-paid` | `opencode-go/deepseek-v4-flash` | subagent | Paid fallback for `tests` |
| `lint` | `opencode/deepseek-v4-flash-free` | subagent | Formatting, lint, imports, style |
| `lint-paid` | `opencode-go/deepseek-v4-flash` | subagent | Paid fallback for `lint` |
| `docs` | `opencode/deepseek-v4-flash-free` | subagent | README, docs, comments, changelogs |
| `docs-paid` | `opencode-go/deepseek-v4-flash` | subagent | Paid fallback for `docs` |
| `git` | `opencode/deepseek-v4-flash-free` | subagent | Commit messages, PR summaries, release notes |
| `git-paid` | `opencode-go/deepseek-v4-flash` | subagent | Paid fallback for `git` |
| `memory` | `opencode/deepseek-v4-flash-free` | subagent | Repository memory, project summaries |
| `memory-paid` | `opencode-go/deepseek-v4-flash` | subagent | Paid fallback for `memory` |
| `terminal-reader` | `opencode/deepseek-v4-flash-free` | subagent | Compress terminal → errors, first failure, files |
| `terminal-reader-paid` | `opencode-go/deepseek-v4-flash` | subagent | Paid fallback for `terminal-reader` |
| `log-reader` | `opencode/deepseek-v4-flash-free` | subagent | Compress logs → exceptions, timestamps, subsystem |
| `log-reader-paid` | `opencode-go/deepseek-v4-flash` | subagent | Paid fallback for `log-reader` |
| `diff-reader` | `opencode/deepseek-v4-flash-free` | subagent | Compress diffs → changed APIs, risky files |
| `diff-reader-paid` | `opencode-go/deepseek-v4-flash` | subagent | Paid fallback for `diff-reader` |
| `vision` | `opencode/mimo-v2.5-free` | subagent | Screenshots, OCR, diagrams → structured markdown |
| `vision-paid` | `opencode-go/mimo-v2.5` | subagent | Paid vision fallback when MiMo Free is unavailable |

★ = default/primary agent. `*-paid` = one paid retry for the free worker before Smart takes over.

## Model Inventory

| Model | Provider | Role |
|-------|----------|------|
| `opencode-go/deepseek-v4-flash` | Go bundle | Smart lead (default) + chores/workers paid fallback |
| `cursor/*` (configured) | Cursor subscription | Cursor lead (opt-in); set in `agent.cursor.model` |
| `opencode/deepseek-v4-flash-free` | Zen bundle | Chores/workers (free) |
| `opencode/mimo-v2.5-free` | Zen bundle | Vision (free) |
| `opencode-go/mimo-v2.5` | Go bundle | Vision fallback (paid) |

The OpenAI provider is disabled (`disabled_providers: ["openai"]`).

## Plugins

| Plugin | File | Role |
|--------|------|------|
| `cursor-oauth-opencode` | (npm package) | Cursor OAuth provider for subscription-backed `cursor/*` models |
| `image-router` | `plugins/image-router.js` | Strips image data from messages to the text-only `smart` lead only, writes the image to disk, and inserts `[IMAGE DETECTED]` markers so smart can delegate to `vision`. Does not run for `cursor`. |
| `cursor-vision` | `plugins/cursor-vision.js` | Forces `attachment` / `input.image` on all `cursor` and `cursor-code` models so OpenCode does not strip clipboard images (cursor-oauth's vision allowlist is otherwise Smart-unrelated and too narrow for Grok 4.5). |
| `herdr-agent-state` | `plugins/herdr-agent-state.js` | herdr workspace + agent state integration (managed by herdr) |

## Structure

```
opencode.jsonc    — 22 agents
agent/            — 22 agent definitions
instructions/     — ai-engineering-system.md
plugins/          — image-router.js, cursor-vision.js, herdr-agent-state.js
```
