# opencode — Personal AI Engineering System

Personal configuration for [opencode](https://opencode.ai), built around a **cost-efficient, accuracy-first** multi-agent architecture.

## Architecture

1. **Free-first, paid-fallback** — Free tiers (DeepSeek V4 Flash Free, MiMo V2.5 Free) are default, with one paid retry (`*-paid`) before escalating. The OpenAI lane uses its cheapest tier (Luna, still paid). Day-to-day costs stay near zero.
2. **Compress before reasoning** — Large output (logs, diffs, terminal, screenshots) is compressed by cheap Flash readers before reaching expensive reasoning models. Token burn reduced by 10–100×.
3. **Three-tier hierarchy** — Every lane splits into Utility (cheapest, mechanical), Delivery (normal coding/review), and Assurance (expensive, gated only). Ordinary work never touches the top tier.

> **Accuracy overrides cost.** Never chooses a cheaper model if it increases the chance of incorrect implementation, unsafe command, or data loss.

## Request Flow

```
Request → router (Flash Free)
  ├─ Trivial → answer directly
  ├─ Utility → tests/lint/docs/git/worker (Flash Free) → *-paid (Flash) → minimax-code
  ├─ Routine coding → minimax-code (MiniMax M3) → minimax-reviewer (MiniMax M3)
  ├─ Multi-component → orchestrator (MiniMax M3)
  ├─ Assurance gate → glm-engineer (GLM 5.2) → spec → minimax-code → reviewer (GLM 5.2)
  ├─ Image detected → vision (MiMo Free) → vision-paid → media-expert
  └─ OpenAI-only → openai (Luna) → openai-coder (Terra) → openai-reviewer (Terra)
                     └─ Assurance gate → openai-sol-engineer (Sol) → spec → openai-coder → openai-sol-reviewer
```

## All Agents

| Agent | Model | Tier / Lane | Role |
|-------|-------|-------------|------|
| `router` ★ | `opencode/deepseek-v4-flash-free` | Free / Routing | Default first hop: answers trivial, routes all else |
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
| `minimax-code` | `opencode-go/minimax-m3` | Paid / Delivery | Features, refactors, bug fixes, integration |
| `minimax-reviewer` | `opencode-go/minimax-m3` | Paid / Delivery | Normal-risk independent reviewer (read-only) |
| `glm-engineer` | `opencode-go/glm-5.2` | Paid / Assurance | **Gate only.** Returns spec, invariants, tests (read-only) |
| `reviewer` | `opencode-go/glm-5.2` | Paid / Assurance | **Gate only.** High-assurance reviewer (read-only) |
| `gpt-expert` | `openai/gpt-5.6-sol` | Paid / Assurance | Rare consult when GLM insufficient (read-only) |
| `openai` | `openai/gpt-5.6-luna` | Paid / OpenAI | OpenAI first hop: Luna → Terra → Sol |
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
| `openai-sol-engineer` | `openai/gpt-5.6-sol` | Paid / OpenAI | **Gate only.** Architecture, security, migrations (read-only) |
| `openai-sol-reviewer` | `openai/gpt-5.6-sol` | Paid / OpenAI | **Gate only.** High-assurance reviewer (read-only) |

★ = default/primary agent. `*-paid` = one paid retry for any free utility before escalating.

## Review Cycle

Every code change gets independent review — not just for correctness, but as the core cost-control mechanism:

```
coder → reviewer → coder applies fixes → re-review → approved or escalated
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

Expensive assurance (GLM 5.2 / GPT-5.6 Sol) is invoked **only** when:

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

Ordinary behaviour-changing or externally visible work is **not** an assurance trigger — it stays in the delivery lane.

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
opencode.jsonc    — 42 agents, 502 lines
agent/            — 42 agent definitions
instructions/     — ai-engineering-system.md (162 lines)
plugins/          — image-router.js, herdr-agent-state.js
```

## Quick Reference

| Request Type | Route |
|-------------|-------|
| Trivial/read-only | Answer directly |
| Tests, fixtures, lint, docs, git, boilerplate | `{specialist}` → `{specialist}-paid` → `minimax-code` |
| Features, refactors, bug fixes | `minimax-code` → `minimax-reviewer` |
| Multi-component (non-OpenAI) | `orchestrator` → specialists |
| Architecture, security, data integrity | `glm-engineer` → spec → `minimax-code` → `reviewer` |
| Images, screenshots | `vision` → `vision-paid` → `media-expert` |
| OpenAI-only tasks | `openai` → `openai-coder` → `openai-reviewer` |
| OpenAI assurance | `openai-sol-engineer` → spec → `openai-coder` → `openai-sol-reviewer` |
