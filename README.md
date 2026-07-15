# opencode — Personal AI Engineering System

Personal configuration for [opencode](https://opencode.ai), built around a **cost-efficient, accuracy-first** multi-agent architecture. Every agent is chosen to minimise cost while maximising quality — the system never sacrifices correctness for savings.

## Architecture Philosophy

The system is designed around three core principles:

1. **Free-first, paid-fallback lane** — Free tiers (DeepSeek V4 Flash Free, MiMo V2.5 Free) are used by default, with an automatic paid retry (`*-paid`) before escalating. The OpenAI lane has its own cheapest tier (Luna, still paid). This keeps day-to-day costs near zero.
2. **Compress before reasoning** — Large logs, diffs, terminal output, and test output are always compressed by cheap Flash readers before reaching expensive reasoning models. This reduces token burn by 10–100× per session.
3. **Three-tier model hierarchy** — Every provider lane is split into Utility (cheapest, mechanical work), Delivery (normal coding/review), and Assurance (expensive, gated decisions only). Ordinary work never touches the expensive tier.

> **Accuracy overrides cost.** The system always uses the cheapest model that satisfies the required accuracy, risk level, modality, and context size — but never chooses a cheaper model if it would materially increase the chance of incorrect implementation, unsafe command, data loss, security regression, or misleading output.

## Agent Systems Overview

### Routing Layer (First Hop)

| Agent | Model | Role |
|-------|-------|------|
| `router` | `opencode/deepseek-v4-flash-free` | Default primary: answers trivial queries directly, routes everything else to the cheapest capable specialist |
| `router-paid` | `opencode-go/deepseek-v4-flash` | Selectable fallback when Flash Free cannot start |
| `orchestrator` | `opencode-go/minimax-m3` | Coordinates work spanning multiple components (non-OpenAI) |
| `openai` | `openai/gpt-5.6-luna` | OpenAI-only first hop: Luna utility, Terra delivery, Sol assurance |
| `openai-orchestrator` | `openai/gpt-5.6-terra` | Selectable Terra fallback and multi-component OpenAI coordinator |

The `router` inspects every request. Trivial or read-only queries are answered immediately. Everything else is classified and routed to the cheapest appropriate lane. Multi-component work goes to `orchestrator` (non-OpenAI) or `openai-orchestrator` (OpenAI-only). OpenAI-only requests are never routed to non-OpenAI agents.

### Delivery Lanes

#### Non-OpenAI Lane (Default — MiniMax M3 + GLM 5.2)

| Agent | Model | Role |
|-------|-------|------|
| `minimax-code` | `opencode-go/minimax-m3` | Normal-risk features, refactors, bug fixes, integration changes |
| `minimax-reviewer` | `opencode-go/minimax-m3` | Independent read-only reviewer for normal-risk changes |
| `glm-engineer` | `opencode-go/glm-5.2` | **Assurance gate only.** Read-only decision lead for architecture, security, data-integrity, ambiguous design. Returns bounded specification, invariants, and required tests; never edits |
| `reviewer` | `opencode-go/glm-5.2` | **Assurance gate only.** High-assurance reviewer for gated changes |
| `gpt-expert` | `openai/gpt-5.6-sol` | Rare final consultation when GLM is insufficient for an assurance decision |

#### OpenAI-Only Lane (Luna → Terra → Sol)

| Agent | Model | Role |
|-------|-------|------|
| `openai-coder` | `openai/gpt-5.6-terra` | Bounded features, refactors, bug fixes (Terra delivery) |
| `openai-reviewer` | `openai/gpt-5.6-terra` | Read-only normal-risk reviewer |
| `openai-sol-engineer` | `openai/gpt-5.6-sol` | **Assurance gate only.** Architecture, security, migrations, ambiguous behaviour — returns specification only, never edits |
| `openai-sol-reviewer` | `openai/gpt-5.6-sol` | **Assurance gate only.** Final high-assurance reviewer |

### Utility Specialists (Free + Paid)

Every utility has a free DeepSeek V4 Flash Free agent and a paid DeepSeek V4 Flash fallback (`*-paid`). The parent retries once on availability/quota failure before escalating.

| Agent | Free Model | Role |
|-------|-----------|------|
| `worker` / `worker-paid` | `opencode/deepseek-v4-flash-free` | Low-risk mechanical implementation, boilerplate, CRUD, fixtures, mocks, simple refactors |
| `tests` / `tests-paid` | `opencode/deepseek-v4-flash-free` | Test authoring, integration tests, snapshots, fixtures, mock updates |
| `lint` / `lint-paid` | `opencode/deepseek-v4-flash-free` | Formatting, import cleanup, style-only fixes (no intentional behaviour changes) |
| `docs` / `docs-paid` | `opencode/deepseek-v4-flash-free` | README, markdown docs, comments, changelogs |
| `git` / `git-paid` | `opencode/deepseek-v4-flash-free` | Commit messages, PR summaries, release notes, git hygiene |
| `memory` / `memory-paid` | `opencode/deepseek-v4-flash-free` | Rolling repository memory and project summaries |

### Compression Readers

These agents exist to **shrink expensive input before it reaches reasoning models**. They are never allowed to edit, delegate, or solve — they only summarise evidence. Every compression reader has a paid fallback.

| Agent | Free Model | Role |
|-------|-----------|------|
| `terminal-reader` / `terminal-reader-paid` | `opencode/deepseek-v4-flash-free` | Compresses large terminal output into errors, first failure, root cause, affected files |
| `log-reader` / `log-reader-paid` | `opencode/deepseek-v4-flash-free` | Compresses logs into repeated exceptions, timestamps, frequencies, failing subsystem |
| `diff-reader` / `diff-reader-paid` | `opencode/deepseek-v4-flash-free` | Compresses git diffs into changed APIs, risky files, behavioural changes, migration notes |

### Vision & Media Agents

| Agent | Model | Role |
|-------|-------|------|
| `vision` | `opencode/mimo-v2.5-free` | Structured markdown description of screenshots, diagrams, code images, OCR — **auto-invoked when an image is detected** |
| `vision-paid` | `opencode-go/mimo-v2.5` | Paid fallback for visual parsing |
| `media-expert` | `openai/gpt-5.6-terra` | Complex media visioning, complicated UI reasoning, Figma-like interpretation, multimodal debugging |
| `openai-media-expert` | `openai/gpt-5.6-terra` | OpenAI-only media/vision specialist |

The `image-router.js` plugin automatically strips image data from chat messages, writes it to disk, and replaces it with `[IMAGE DETECTED: …]` markers. Any agent receiving such a marker must immediately delegate to the `vision` agent — no text-only model ever attempts to interpret images.

### OpenAI-Only Utility Specialists (Luna 5.6)

When using the OpenAI-only lane, Luna-based agents mirror the Flash utility agents:

| Agent | Model | Role |
|-------|-------|------|
| `openai-luna-worker` | `openai/gpt-5.6-luna` | Low-risk mechanical work |
| `openai-luna-tests` | `openai/gpt-5.6-luna` | Test updates, fixtures, mocks |
| `openai-luna-docs` | `openai/gpt-5.6-luna` | Documentation |
| `openai-luna-git` | `openai/gpt-5.6-luna` | Git communication |
| `openai-luna-lint` | `openai/gpt-5.6-luna` | Formatting and lint |
| `openai-luna-reader` | `openai/gpt-5.6-luna` | Output/diff compression |

---

## Cost-Efficiency Design

### Three-Tier Model Selection

Every provider lane follows the same architecture:

```
Utility (cheapest)     →     Delivery (mid-cost)     →     Assurance (expensive)
  Flash Free                         MiniMax M3                        GLM 5.2
  Luna 5.6                           Terra 5.6                          Sol 5.6
```

- **Utility** handles mechanical, well-specified, low-risk work (boilerplate, tests, docs, lint, compression). Uses the free tier by default in the non-OpenAI lane; the OpenAI lane uses its cheapest paid model (Luna).
- **Delivery** handles normal-risk features, refactors, debugging, and routine review. Uses a paid mid-cost model only when needed.
- **Assurance** is *only* invoked when an explicit gate is met (see below). Uses the most expensive model, but rarely.

### Fallback Chains

Each primary agent has a defined fallback path that prevents silent degradation while avoiding unnecessary escalation to the most expensive models:

| Primary | Paid Retry | If Both Fail |
|---------|-----------|-------------|
| DeepSeek Flash Free | DeepSeek Flash (paid) | MiniMax M3 or ask user — never GLM |
| MiMo V2.5 Free | MiMo V2.5 (paid) | GPT 5.6 Terra (if OpenAI available) → MiniMax text follow-up → ask user |
| Luna (GPT 5.6) | Terra (GPT 5.6) | Ask user — never uses non-OpenAI models |
| Terra (GPT 5.6) | Ask user | Sol is never an availability fallback |
| GLM 5.2 | Ask user | No replacement — assurance models never have fallbacks |
| MiniMax M3 | Ask user | GLM is never an availability fallback |

### Compress Before Reasoning

Before any expensive reasoning model processes data, cheap utility agents compress the input. This is the single highest-impact cost-saving measure in the system:

- **Terminal output** → `terminal-reader`: preserves exit code, first failure, exact errors, file paths, line numbers
- **Logs** → `log-reader`: preserves timestamps, exception frequencies, failing subsystem
- **Git diffs** → `diff-reader`: preserves changed APIs, risky files, behavioural changes
- **Screenshots** → `vision` → `vision-paid` → `media-expert`: structured markdown summary replaces raw pixel data

A 10,000-line test output becomes a 20-line evidence packet. A 500 KB screenshot becomes a structured markdown block. This reduces the token payload for MiniMax/GLM/Sol by 10–100× per session.

### Evidence-Gated Escalation

The system never escalates without evidence:

1. Source code is always inspected before any claim is made
2. Commands are run for verification
3. Confidence must be calculated from evidence (not intuition)
4. Below 80% confidence → reclassify with focused evidence; escalate to GLM/Sol only if the assurance gate is met
5. Below 60% confidence → stop and ask the user

### Maximum Delegation Depth

Delegation is capped at **3 levels** to prevent runaway costs and context overwrite. Agents never re-delegate the same task class. Task-denied agents (readers, vision agents, reviewers, decision agents) never delegate at all — they return exact handoffs to their parent, who owns all further routing.

---

## Why Automatic Back-and-Forth Reviews Save Money AND Produce Better Results

The system uses a **report → fix → re-review** cycle as the core quality mechanism. This is not an afterthought — it is a deliberate design choice that simultaneously reduces cost and improves reliability.

### How the Cycle Works

```
┌─────────────┐     implementation      ┌─────────────┐
│             │ ──────────────────────►  │             │
│   Coder     │                          │  Reviewer   │
│  (MiniMax   │ ◄──────────────────────  │  (MiniMax   │
│   Terra)    │     actionable report    │   Terra)    │
│             │     or approval          │             │
└─────────────┘                          └─────────────┘
       │                                        │
       │ After 2 failed cycles                  │ After 1 failed cycle (OpenAI)
       ▼                                        ▼
┌─────────────┐                          ┌─────────────┐
│  Assurance   │                         │  Assurance   │
│  Gate (GLM)  │                         │  Gate (Sol)  │
└─────────────┘                          └─────────────┘
```

Every code-writing task is followed by an independent review:

1. **Coder** implements the feature/fix and returns verification evidence (diff, test results, exit codes)
2. **Reviewer** inspects changes independently and returns an actionable report or approval
3. **Coder** applies the review's requested fixes and returns fresh evidence
4. **Reviewer** re-inspects the new diff
5. After **2 failed cycles** (non-OpenAI) or **1 failed cycle** (OpenAI), the assurance gate is met and the expensive tier is activated

### Why This Saves Money

1. **Catches errors when they're cheapest.** A bug caught in the first review cycle costs ~1,000 tokens to report and fix. The same bug caught in production costs thousands in debugging time, context rebuilds, and emergency escalation.

2. **Prevents unnecessary assurance invocation.** Without a review step, uncertain coders would over-escalate to expensive models (GLM/Sol). With review, 90%+ of issues are resolved in the delivery lane using only mid-cost models.

3. **Eliminates single-point-of-failure.** A single agent can hallucinate, miss edge cases, or apply inconsistent patterns. The reviewer acts as a second independent pass, catching issues before they reach the expensive escalation path.

4. **Reduces large-context reruns.** Instead of rerunning a full implementation from scratch when something is wrong, the fix cycle applies a focused patch — using 10–20× fewer tokens than a full rewrite.

5. **Keeps cheap agents honest.** Knowing there will be a review, coders produce more careful, self-reviewed output, reducing the revision count per task.

### Why This Produces More Reliable Results

1. **Two independent perspectives.** The coder and reviewer use the same model but approach the problem from different roles (creator vs. critic). This catches blind spots that a single pass would miss.

2. **Structured evidence packet.** Both agents work from the same focused evidence: goal, acceptance criteria, file scope, diff, verification results. The reviewer never needs to rediscover context.

3. **Actionable findings.** Review reports are required to include file/line references, expected behaviour, required tests, and risk assessment. "Looks good" is never a valid review.

4. **Explicit fix cycles.** Each cycle is counted. After the maximum cycle limit without resolution, the task escalates with a full evidence packet to the assurance tier, which has more context capacity and deeper reasoning.

5. **Risk-based review depth.** Normal-risk code gets MiniMax/Terra review. High-risk code (security, data integrity, API compatibility) gets GLM/Sol review — but only after the delivery lane has failed to resolve it.

6. **No credentialism.** The reviewer cannot edit code — it can only report findings. This forces clear communication and prevents silent "fix-ups" that might introduce new bugs.

7. **Verification is mandatory.** Every code change must return verification commands and their exit codes. Reviewers check that evidence matches claims. If evidence is missing, they return `EVIDENCE_NEEDED` instead of approving.

### Key Design Rules

- Normal-risk executable changes **always** require independent review through `minimax-reviewer` (non-OpenAI) or `openai-reviewer` (OpenAI-only)
- GLM `reviewer` is required **only** when the assurance gate is met — never for routine review
- Docs-only, formatting-only, and clear fixture/snapshot-only changes skip review unless they independently meet the assurance gate
- After 2 failed MiniMax cycles or 1 failed Terra cycle, the task is escalated to the assurance tier with a compressed evidence packet
- Review findings are returned to the parent, who assigns repairs and invokes the next review — no agent reviews its own work

---

## Assurance Gate Criteria

The expensive assurance models (`glm-engineer`, `reviewer`, `openai-sol-engineer`, `openai-sol-reviewer`) are used **only** when at least one of these explicit criteria applies:

- Architecture or cross-system design decisions
- Security, privacy, authentication, authorisation, secrets, payments, permissions, or destructive operations
- Migrations, persistence, data integrity, or irreversible data changes
- Public API or schema compatibility
- Concurrency or distributed state
- Compliance or production incidents
- Material ambiguity with materially different implementations
- Confidence remains below 80% after focused evidence collection
- One failed focused Terra fix cycle or two failed focused MiniMax fix cycles
- Independent review of high-risk code authored by an assurance model

**Ordinary behaviour-changing or externally visible work is NOT an assurance trigger.** It stays in the delivery lane and gets routine MiniMax/Terra review.

---

## Model Inventory

| Model ID | Provider | Tier | Lane |
|----------|----------|------|------|
| `opencode/deepseek-v4-flash-free` | OpenCode Zen (bundle) | Free | Utility (default) |
| `opencode-go/deepseek-v4-flash` | OpenCode Go (bundle) | Paid | Utility fallback |
| `opencode/mimo-v2.5-free` | OpenCode Zen (bundle) | Free | Visual parsing |
| `opencode-go/mimo-v2.5` | OpenCode Go (bundle) | Paid | Visual fallback |
| `opencode-go/minimax-m3` | OpenCode Go (bundle) | Paid | Delivery |
| `opencode-go/glm-5.2` | OpenCode Go (bundle) | Paid | Assurance |
| `openai/gpt-5.6-luna` | OpenAI | Paid | OpenAI utility |
| `openai/gpt-5.6-terra` | OpenAI | Paid | OpenAI delivery |
| `openai/gpt-5.6-sol` | OpenAI | Paid | OpenAI assurance |

## Plugins

| Plugin | File | Role |
|--------|------|------|
| `image-router` | `plugins/image-router.js` | Intercepts image data in chat, strips the binary payload, writes it to disk, and replaces it with `[IMAGE DETECTED: …]` markers so text-only router models auto-delegate to `vision` |
| `herdr-agent-state` | `plugins/herdr-agent-state.js` | Manages herdr workspace and agent state integration |

## File Structure

```
opencode.jsonc                           — Main agent configuration (42 agents, 502 lines)
instructions/
  ai-engineering-system.md               — Persistent system instruction (162 lines)
agent/
  router.md                              — Primary cheap first-hop router (DeepSeek Flash Free)
  router-paid.md                         — Paid fallback router (DeepSeek Flash)
  orchestrator.md                        — Non-OpenAI multi-component orchestrator (MiniMax M3)
  minimax-code.md                        — MiniMax delivery engineer
  minimax-reviewer.md                    — MiniMax normal-risk reviewer
  glm-engineer.md                        — GLM assurance decision lead (read-only)
  reviewer.md                            — GLM high-assurance reviewer (read-only)
  gpt-expert.md                          — Rare final GPT consultation (Sol, read-only)
  worker.md                              — Low-risk mechanical work (Flash Free)
  worker-paid.md                         — Paid fallback mechanical work
  tests.md                               — Test specialist (Flash Free)
  tests-paid.md                          — Paid fallback tests
  lint.md                                — Formatting/lint specialist (Flash Free)
  lint-paid.md                           — Paid fallback lint
  docs.md                                — Documentation specialist (Flash Free)
  docs-paid.md                           — Paid fallback docs
  git.md                                 — Git communication specialist (Flash Free)
  git-paid.md                            — Paid fallback git
  memory.md                              — Repository memory maintainer (Flash Free)
  memory-paid.md                         — Paid fallback memory
  terminal-reader.md                     — Terminal output compression (Flash Free)
  terminal-reader-paid.md                — Paid fallback terminal reader
  log-reader.md                          — Log compression (Flash Free)
  log-reader-paid.md                     — Paid fallback log reader
  diff-reader.md                         — Diff compression (Flash Free)
  diff-reader-paid.md                    — Paid fallback diff reader
  vision.md                              — Visual parsing (MiMo Free)
  vision-paid.md                         — Visual parsing fallback (MiMo paid)
  media-expert.md                        — Complex media visioning (GPT-5.6 Terra)
  openai.md                              — OpenAI-only Luna first hop
  openai-orchestrator.md                 — OpenAI-only Terra fallback/coordinator
  openai-coder.md                        — OpenAI-only Terra delivery engineer
  openai-reviewer.md                     — OpenAI-only normal-risk reviewer
  openai-sol-engineer.md                 — OpenAI-only assurance decision lead (read-only)
  openai-sol-reviewer.md                 — OpenAI-only high-assurance reviewer (read-only)
  openai-luna-worker.md                  — OpenAI-only mechanical work (Luna)
  openai-luna-tests.md                   — OpenAI-only test specialist (Luna)
  openai-luna-docs.md                    — OpenAI-only docs specialist (Luna)
  openai-luna-git.md                     — OpenAI-only git specialist (Luna)
  openai-luna-lint.md                    — OpenAI-only lint specialist (Luna)
  openai-luna-reader.md                  — OpenAI-only compression reader (Luna)
  openai-media-expert.md                 — OpenAI-only media specialist (Terra)
plugins/
  image-router.js                        — Image interception plugin
  herdr-agent-state.js                   — herdr integration plugin
```

## Quick Reference

### What routes where?

| Request Type | Router Action |
|-------------|--------------|
| Trivial/read-only | Answer directly |
| Tests, fixtures, mocks | `tests` → `tests-paid` → `minimax-code` |
| Formatting, lint | `lint` → `lint-paid` |
| Docs | `docs` → `docs-paid` |
| Git commits, PRs | `git` → `git-paid` |
| Long terminal output | `terminal-reader` → `terminal-reader-paid` |
| Logs | `log-reader` → `log-reader-paid` |
| Git diffs | `diff-reader` → `diff-reader-paid` |
| Boilerplate, CRUD, mocks | `worker` → `worker-paid` |
| Features, refactors, bug fixes | `minimax-code` → `minimax-reviewer` |
| Multi-component work (non-OpenAI) | `orchestrator` → specialists |
| Architecture, security, data integrity | `glm-engineer` (read-only decision) |
| Assurance review | `reviewer` (read-only) |
| GLM insufficient | `gpt-expert` (read-only) |
| Images, screenshots | Auto-delegate to `vision` → `vision-paid` → `media-expert` |
| Complex media reasoning | `media-expert` |
| OpenAI-only single/trivial | `openai` |
| OpenAI-only multi-component | `openai-orchestrator` |
| OpenAI-only coding | `openai-coder` |
| OpenAI-only review | `openai-reviewer` |
| OpenAI-only assurance | `openai-sol-engineer` / `openai-sol-reviewer` |
