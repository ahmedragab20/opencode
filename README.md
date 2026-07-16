# opencode — Personal AI Engineering System

Personal configuration for [opencode](https://opencode.ai), built around a **cost-efficient, accuracy-first** multi-agent architecture.

## Architecture

1. **Free-first, paid-fallback** — Free tiers (DeepSeek V4 Flash Free, MiMo V2.5 Free) are default, with one paid retry (`*-paid`) before escalating. The OpenAI lane uses its cheapest tier (Luna, still paid). Day-to-day costs stay near zero.
2. **Compress before reasoning** — Large output (logs, diffs, terminal, screenshots) is compressed by cheap Flash readers before reaching expensive reasoning models. Token burn reduced by 10–100×.
3. **Three-tier hierarchy** — Every lane splits into Utility (cheapest, mechanical), Delivery (normal coding/review), and Assurance (expensive, planning + gated review). GLM plans every feature; the gate only determines review level.

> **Accuracy overrides cost.** Never chooses a cheaper model if it increases the chance of incorrect implementation, unsafe command, or data loss.

## Request Flow

```
Request → router (Flash Free) — CLASSIFIER + RELAY ONLY (never plans or sequences)
  Smart agents own the plan, the sequence, and the context; the router only classifies the
  first hop and relays each agent's HANDOFF directive. Tests/diffs/logs run through cheap
  Flash (or Luna) specialists and pass results back to the smart model that requested them.

  ├─ Trivial/read-only → answered directly by the router
  ├─ Image detected → vision (MiMo Free) → router re-classifies the underlying task → smart agent (with vision description)
  ├─ Utility-only → tests/lint/docs/git/worker/reader (Flash Free) → *-paid (Flash) → DONE
  ├─ Feature/refactor/bug fix → glm-engineer (GLM 5.2) LEADS: gathers evidence via cheap readers, plans
  │     → HANDOFF → minimax-code (MiniMax M3) implements, delegates tests/diffs/logs to Flash
  │     → HANDOFF → minimax-reviewer → DONE (or HANDOFF back to minimax-code for the fix loop)
  ├─ Multi-component → orchestrator (MiniMax M3) LEADS: decomposes, delegates components, synthesizes → DONE
  ├─ Assurance gate → glm-engineer plan → minimax-code → glm-reviewer (GLM 5.2) → DONE (or fix loop)
  └─ OpenAI-only → openai (Luna) classifies + relays → openai-coder (Terra) LEADS
        → HANDOFF → openai-reviewer (Terra) → DONE
        └─ Assurance gate → openai-sol-engineer (Sol) spec → HANDOFF → openai-coder → openai-sol-reviewer → DONE
```

## All Agents

| Agent | Model | Tier / Lane | Role |
|-------|-------|-------------|------|
| `router` ★ | `opencode/deepseek-v4-flash-free` | Free / Routing | Classifier + relay: answers trivial, classifies the first hop, relays smart-agent handoffs |
| `router-paid` | `opencode-go/deepseek-v4-flash` | Paid / Routing | Fallback when Flash Free is unavailable |
| `worker` / `*-paid` | Flash Free / Flash | Free / Utility | Low-risk mechanical, boilerplate, CRUD, mocks |
| `tests` / `*-paid` | Flash Free / Flash | Free / Utility | Tests, snapshots, fixtures |
| `lint` / `*-paid` | Flash Free / Flash | Free / Utility | Formatting, imports, style (no behaviour changes) |
| `docs` / `*-paid` | Flash Free / Flash | Free / Utility | README, docs, comments, changelogs |
| `git` / `*-paid` | Flash Free / Flash | Free / Utility | Commit messages, PR summaries, release notes |
| `memory` / `*-paid` | Flash Free / Flash | Free / Utility | Repository memory, project summaries |
| `terminal-reader` / `*-paid` | Flash Free / Flash | Free / Utility | Compress terminal → errors, first failure, files |
| `log-reader` / `*-paid` | Flash Free / Flash | Free / Utility | Compress logs → exceptions, timestamps, subsystem |
| `diff-reader` / `*-paid` | Flash Free / Flash | Free / Utility | Compress diffs → changed APIs, risky files |
| `vision` / `vision-paid` | MiMo Free / MiMo | Free↝Paid / Visual | Screenshots, OCR, diagrams → structured markdown |
| `media-expert` | `openai/gpt-5.6-terra` | Paid / Visual | Complex UI reasoning, Figma, multimodal |
| `orchestrator` | `opencode-go/minimax-m3` | Paid / Delivery | Multi-component non-OpenAI coordinator |
| `minimax-code` | `opencode-go/minimax-m3` | Paid / Delivery | Implements GLM plan. Features, refactors, bug fixes, integration |
| `minimax-reviewer` | `opencode-go/minimax-m3` | Paid / Delivery | Normal-risk independent reviewer (read-only) |
| `glm-engineer` | `opencode-go/glm-5.2` | Paid / Assurance | Plans every feature; gathers evidence via cheap readers; returns spec, steps, invariants, tests (read-only) |
| `glm-reviewer` | `opencode-go/glm-5.2` | Paid / Assurance | **Gate only.** High-assurance reviewer (read-only) |
| `gpt-expert` | `openai/gpt-5.6-sol` | Paid / Assurance | Rare consult when GLM insufficient (read-only) |
| `openai` | `openai/gpt-5.6-luna` | Paid / OpenAI | OpenAI first-hop classifier-relay (Luna) → Terra delivery / Sol gated assurance |
| `openai-orchestrator` | `openai/gpt-5.6-terra` | Paid / OpenAI | Terra fallback + multi-component coordinator |
| `openai-coder` | `openai/gpt-5.6-terra` | Paid / OpenAI | Features, refactors, bug fixes |
| `openai-reviewer` | `openai/gpt-5.6-terra` | Paid / OpenAI | Normal-risk reviewer (read-only) |
| `openai-luna-worker` | `openai/gpt-5.6-luna` | Paid / OpenAI | Mechanical work |
| `openai-luna-tests` | `openai/gpt-5.6-luna` | Paid / OpenAI | Tests, fixtures, mocks |
| `openai-luna-docs` | `openai/gpt-5.6-luna` | Paid / OpenAI | Documentation |
| `openai-luna-git` | `openai/gpt-5.6-luna` | Paid / OpenAI | Git communication |
| `openai-luna-lint` | `openai/gpt-5.6-luna` | Paid / OpenAI | Formatting and lint |
| `openai-luna-reader` | `openai/gpt-5.6-luna` | Paid / OpenAI | Output/diff compression |
| `openai-media-expert` | `openai/gpt-5.6-terra` | Paid / OpenAI | Media, screenshots, OCR, UI |
| `openai-sol-engineer` | `openai/gpt-5.6-sol` | Paid / OpenAI | **Gate only.** Architecture, security, migrations; delegates compression to `openai-luna-reader` (read-only) |
| `openai-sol-reviewer` | `openai/gpt-5.6-sol` | Paid / OpenAI | **Gate only.** High-assurance reviewer (read-only) |

★ = default/primary agent. `*-paid` = one paid retry for any free utility before escalating.

## Review Cycle

GLM plans every feature, MiniMax implements, and every code change gets independent review — not just for correctness, but as the core cost-control mechanism:

```
coder → normal-risk reviewer → coder applies fixes → re-review → approved
        └─ gate met or failed cycles → assurance reviewer → coder fixes → approved
  MiniMax lane: minimax-reviewer → glm-reviewer
  OpenAI lane:  openai-reviewer → openai-sol-reviewer
```

After 2 failed MiniMax cycles or 1 failed Terra cycle, the task escalates to assurance. Docs-only, formatting-only, and clear fixture/snapshot-only changes skip review unless they independently meet the assurance gate. Delegation is capped at 3 levels.

## Fallback Chains

| Primary | Paid Retry | If Both Fail |
|---------|-----------|-------------|
| DeepSeek Flash Free | DeepSeek Flash (paid) | MiniMax M3 or ask |
| MiMo V2.5 Free | MiMo V2.5 (paid) | GPT-5.6 Terra → MiniMax text → ask |
| Luna (GPT-5.6) | Terra (GPT-5.6) | Ask — never non-OpenAI |
| Terra / MiniMax M3 / GLM 5.2 | Ask user | No cross-tier availability fallback |

## Assurance Gate

GLM 5.2 plans every feature, refactor, and bug fix. The assurance gate determines the **review level**, not whether GLM is invoked:

- `minimax-reviewer` (MiniMax M3) handles all normal-risk review
- `glm-reviewer` (GLM 5.2) or `openai-sol-reviewer` (Sol) handles **gated** review when:

  - Architecture, cross-system design
  - Security, auth, secrets, payments, permissions, destructive ops
  - Migrations, persistence, data integrity, irreversible changes
  - Public API or schema compatibility
  - Concurrency, distributed state
  - Compliance, production incidents
  - Material ambiguity with materially different implementations
  - Confidence below 80% after focused evidence
  - Two failed MiniMax cycles or one failed Terra cycle
  - Review of high-risk code authored by an assurance model

Ordinary behaviour-changing or externally visible work still gets planned by GLM but reviewed in the delivery lane.

## Model Inventory

| Model | Provider | Tier |
|-------|----------|------|
| `opencode/deepseek-v4-flash-free` | Zen bundle | Free utility |
| `opencode-go/deepseek-v4-flash` | Go bundle | Paid utility fallback |
| `opencode/mimo-v2.5-free` | Zen bundle | Free visual |
| `opencode-go/mimo-v2.5` | Go bundle | Paid visual fallback |
| `opencode-go/minimax-m3` | Go bundle | Paid delivery |
| `opencode-go/glm-5.2` | Go bundle | Paid assurance |
| `openai/gpt-5.6-luna` | OpenAI | Paid utility |
| `openai/gpt-5.6-terra` | OpenAI | Paid delivery |
| `openai/gpt-5.6-sol` | OpenAI | Paid assurance |

## Plugins

| Plugin | File | Role |
|--------|------|------|
| `image-router` | `plugins/image-router.js` | Strips image data, writes to disk, inserts `[IMAGE DETECTED]` markers so text-only models auto-delegate to `vision` |
| `herdr-agent-state` | `plugins/herdr-agent-state.js` | herdr workspace + agent state integration |

## Structure

```
opencode.jsonc    — 42 agents, 526 lines
agent/            — 42 agent definitions
instructions/     — ai-engineering-system.md (201 lines)
plugins/          — image-router.js, herdr-agent-state.js
```

## Quick Reference

The router classifies the first hop and relays `HANDOFF → <agent>` directives; smart agents lead each step. All tests/diffs/logs go through cheap specialists and pass back to the leading smart model.

| Request Type | First hop (router) → smart lead → handoff chain |
|-------------|-------|
| Trivial/read-only | Router answers directly |
| Tests, fixtures, lint, docs, git, boilerplate | Flash `{specialist}` → `*-paid` → `minimax-code` (if escalation) |
| Features, refactors, bug fixes | `glm-engineer` leads (plans + gathers evidence) → `minimax-code` → `minimax-reviewer` |
| Multi-component (non-OpenAI) | `orchestrator` leads → delegates components → synthesizes |
| Gated (security, migrations, etc.) | `glm-engineer` leads → `minimax-code` → `glm-reviewer` (GLM) |
| Images, screenshots | `vision` → router re-classifies → smart lead (with vision description) |
| OpenAI-only tasks | `openai` (Luna) classifies + relays → `openai-coder` (Terra) leads → `openai-reviewer` |
| OpenAI assurance | `openai-sol-engineer` (Sol) leads → `openai-coder` → `openai-sol-reviewer` |
