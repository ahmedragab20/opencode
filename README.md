# opencode — Personal AI Engineering System

Personal configuration for [opencode](https://opencode.ai), built around a simple, reliable two-model architecture with three opt-in primary leads.

## Architecture — Smart Leads, Workers Follow

Three primary leads share the same routing and worker delegation; only the reasoning model differs:

- **`smart`** (default) — DeepSeek V4 Flash via `opencode-go`
- **`cursor`** (opt-in) — Cursor subscription via `cursor/*` (`cursor-oauth-opencode`)
- **`otto`** (opt-in) — Cursor subscription via `cursor-otto/*` (`@otto-assistant` bridge; runs alongside `cursor`)

```
User → smart (default), cursor, or otto — the lead. Plans, implements, verifies, reviews.
  ├─ Chores → Flash workers (DeepSeek V4 Flash Free): tests, lint, docs, git,
  │           worker, memory, terminal-reader, log-reader, diff-reader
  │           → each hands its result back to the lead
  │           → if a free worker is down, retry once with its *-paid twin
  │             (DeepSeek V4 Flash, opencode-go) before the lead does it itself
  ├─ Images (all leads) → image-router auto-runs vision (GPT 5.6 Luna) → vision-free fallback
```

The lead owns every request end to end. It does the reasoning and substantive implementation itself and delegates only mechanical chores to cheap Flash workers, which follow its instructions and hand results back. Each free worker has a `*-paid` twin (same role, paid DeepSeek V4 Flash) for one retry when the free tier is unavailable. **All primary leads** (Smart, Cursor, Otto) have no native vision — `image-router` auto-delegates pasted images to `vision` (`opencode-go/gpt-5.6-luna`) and injects `[VISION DESCRIPTION]`; `vision-free` (`opencode/mimo-v2.5-free`) is the one-time fallback if Luna fails.

> **Accuracy overrides cost.** Never choose a cheaper path if it increases the chance of incorrect implementation, unsafe command, or data loss.

## Switching leads

| Action | Command / gesture |
|--------|-------------------|
| Start TUI with Cursor | `opencode --agent cursor` |
| Start TUI with Otto | `opencode --agent otto` |
| Cycle agents in TUI | Tab |
| One-shot run with Cursor | `opencode run --agent cursor` |
| One-shot run with Otto | `opencode run --agent otto` |

Default remains `smart`. After config or plugin changes, restart opencode if the new agent or provider does not appear.

## Cursor auth

After the `cursor-oauth-opencode` plugin is installed, authenticate once:

```bash
opencode auth login --provider cursor
```

Prefer native `cursor/*` models and tools when the Cursor lead is active. Change the lead model anytime via `agent.cursor.model` in `opencode.jsonc` (and the matching frontmatter in `agent/cursor.md`); it is not locked to a specific Cursor catalog entry.

**Otto** uses the same OAuth token (`cursor` in `auth.json`) but a separate provider (`cursor-otto/*`) backed by `@otto-assistant/opencode-cursor-oauth`. Change the Otto lead model via `agent.otto.model` / `agent.otto.variant` (default `cursor-otto/grok-4.5` + `high`). No separate login — `opencode auth login --provider cursor` covers both Cursor and Otto.

## Agents

| Agent | Model | Mode | Role |
|-------|-------|------|------|
| `smart` ★ | `opencode-go/deepseek-v4-flash` | primary | Smart lead (default): plans, implements, verifies, reviews; delegates chores + images |
| `cursor` | `cursor/*` (see `agent.cursor.model`) | primary | Cursor lead (opt-in): same routing as Smart; subscription reasoning via cursor-oauth-opencode; delegates images + chores |
| `otto` | `cursor-otto/*` (see `agent.otto.model`) | primary | Otto lead (opt-in): same routing as Smart; subscription reasoning via @otto-assistant bridge; delegates images + chores |
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
| `vision` | `opencode-go/gpt-5.6-luna` | subagent | Screenshots, OCR, diagrams → structured markdown |
| `vision-free` | `opencode/mimo-v2.5-free` | subagent | Free MiMo vision fallback when Luna is unavailable |

★ = default/primary agent. `*-paid` = one paid retry for the free worker before Smart takes over.

## Model Inventory

| Model | Provider | Role |
|-------|----------|------|
| `opencode-go/deepseek-v4-flash` | Go bundle | Smart lead (default) + chores/workers paid fallback |
| `cursor/*` (configured) | Cursor subscription | Cursor lead (opt-in); set in `agent.cursor.model` |
| `cursor-otto/*` (configured) | Cursor subscription (Otto bridge) | Otto lead (opt-in); set in `agent.otto.model` |
| `opencode/deepseek-v4-flash-free` | Zen bundle | Chores/workers (free) |
| `opencode-go/gpt-5.6-luna` | Go bundle | Vision (all primary leads) |
| `opencode/mimo-v2.5-free` | Zen bundle | Vision fallback (free) |

The OpenAI provider is disabled (`disabled_providers: ["openai"]`).

## Plugins

| Plugin | File | Role |
|--------|------|------|
| `cursor-oauth-opencode` | (npm package) | Cursor OAuth provider for subscription-backed `cursor/*` and `cursor-code/*` models |
| `cursor-otto` | `plugins/cursor-otto.js` | Separate `cursor-otto/*` provider using `@otto-assistant/opencode-cursor-oauth` runtime; shares OAuth with `cursor`; proxy on port 8789 |
| `image-router` | `plugins/image-router.js` | Strips image data from primary leads (`smart`, `cursor`, `otto`), writes files to disk, **auto-runs `vision`** with native attachments, injects `[VISION DESCRIPTION]`; falls back to `vision-free` — never denies lead access |
| `herdr-agent-state` | `plugins/herdr-agent-state.js` | herdr workspace + agent state integration (managed by herdr) |

## Structure

```
opencode.jsonc    — 23 agents
agent/            — 23 agent definitions
instructions/     — ai-engineering-system.md
plugins/          — image-router.js, cursor-otto.js, herdr-agent-state.js
```