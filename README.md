# opencode — Personal AI Engineering System

Personal configuration for [opencode](https://opencode.ai), built around a simple, reliable two-model architecture.

## Architecture — Smart Leads, Workers Follow

```
User → glm (GLM 5.2) — the smart lead. Plans, implements, verifies, reviews.
  ├─ Chores → Flash workers (DeepSeek V4 Flash Free): tests, lint, docs, git,
  │           worker, memory, terminal-reader, log-reader, diff-reader
  │           → each hands its result back to glm
  │           → if a free worker is down, retry once with its *-paid twin
  │             (DeepSeek V4 Flash, opencode-go) before glm does it itself
  └─ Images → vision (MiMo V2.5 Free) → vision-paid (MiMo V2.5) fallback
              → hands a structured markdown description back to glm
```

GLM 5.2 owns every request end to end. It does the reasoning and substantive implementation itself and delegates only mechanical chores to cheap Flash workers, which follow its instructions and hand results back. Each free worker has a `*-paid` twin (same role, paid DeepSeek V4 Flash) for one retry when the free tier is unavailable. GLM 5.2 has no vision, so images go to the `vision` agent (with `vision-paid` as fallback).

> **Accuracy overrides cost.** Never choose a cheaper path if it increases the chance of incorrect implementation, unsafe command, or data loss.

## Agents

| Agent | Model | Mode | Role |
|-------|-------|------|------|
| `glm` ★ | `opencode-go/glm-5.2` | primary | Smart lead: plans, implements, verifies, reviews; delegates chores + images |
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

★ = default/primary agent. `*-paid` = one paid retry for the free worker before GLM takes over.

## Model Inventory

| Model | Provider | Role |
|-------|----------|------|
| `opencode-go/glm-5.2` | Go bundle | Smart lead (paid) |
| `opencode/deepseek-v4-flash-free` | Zen bundle | Chores/workers (free) |
| `opencode-go/deepseek-v4-flash` | Go bundle | Chores/workers paid fallback |
| `opencode/mimo-v2.5-free` | Zen bundle | Vision (free) |
| `opencode-go/mimo-v2.5` | Go bundle | Vision fallback (paid) |

The OpenAI provider is disabled (`disabled_providers: ["openai"]`).

## Plugins

| Plugin | File | Role |
|--------|------|------|
| `image-router` | `plugins/image-router.js` | Strips image data from messages to the text-only `glm` lead, writes the image to disk, and inserts `[IMAGE DETECTED]` markers so glm can delegate to `vision` |
| `herdr-agent-state` | `plugins/herdr-agent-state.js` | herdr workspace + agent state integration (managed by herdr) |

## Structure

```
opencode.jsonc    — 21 agents
agent/            — 21 agent definitions
instructions/     — ai-engineering-system.md
plugins/          — image-router.js, herdr-agent-state.js
```
