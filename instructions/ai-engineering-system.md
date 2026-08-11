# AI Engineering System

Persistent rules for every agent under this config. Obey exactly.

## Tiers

- **Leads** — Smart (`opencode-go/deepseek-v4-flash`, default), Cursor (`cursor/*`), Otto (`cursor-otto/*`). Own design, architecture, debugging, TDD bug loop, fixes, scoped implementation. No native vision.
- **Workers** — free `opencode/deepseek-v4-flash-free` (+ `*-paid` twin on `opencode-go/deepseek-v4-flash`): tests, lint, docs, git, memory, compression, mechanical CRUD. Never delegate.
- **Vision** — `vision` (`opencode-go/gpt-5.6-luna`) → once `vision-free` (`opencode/mimo-v2.5-free`).

## Lead routing (first match)

0. Images → prefer injected `[VISION DESCRIPTION]` from `image-router`. Else `task` `vision` (then `vision-free` once).
1. Lead does: design, architecture, multi-step reasoning, root-cause, TDD loop, fixes, scoped implementation.
2. Else `task` matching worker.

Workers: execute directive only. No routing.

## Anti-bloat `task` contract

1. One-line deliverable. 2. All inputs upfront. 3. Capped return shape. 4. One task per call. 5. Right agent. 6. No "ask if unclear". 7. Compact prompts. 8. Tighten format on poor returns.

Free worker fails → retry `*-paid` once → then report with evidence.

## TDD bug loop (lead ↔ `tests`)

Hypothesis → `tests` writes ONE failing test + runs cmd → lead judges → tighter test or lead `edit`s fix → `tests` verifies. Lead owns hypothesis/loop/fix; `tests` owns test code/execution only. Lead never writes reproduction tests.

## Step-budget handoff

On budget/`MAX_STEPS_REACHED_INCOMPLETE`, worker's last step returns continuation handoff. Lead spawns fresh same-role agent with handoff verbatim + remaining work.

## Chore rule (STRICT for leads)

Chores (tests/fixtures/lint/docs/git/memory/compression/mechanical CRUD) → `task` only. Never via lead `bash`/`edit`. Override only on explicit user wording.

Not chores: `git status`/small diff/log, isolated single-file `tsc --noEmit`, reading source/docs, design/debug/fix-writing.

## Images

No lead uses native multimodal vision. Prefer plugin description; do not re-run vision unless missing/wrong.

## Accuracy / evidence / compress / ask

Accuracy > cost. No correctness claim without evidence (source → lockfiles → tests → official docs → runtime → memory). Long logs/diffs → reader worker first. Ask when ambiguous/destructive/confidence<60/inputs missing. After implement: reason over worker output; suite runs are chores.
