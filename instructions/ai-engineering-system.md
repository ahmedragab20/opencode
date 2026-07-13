# AI Engineering System

This instruction is persistent and must be respected throughout long sessions.

## Accuracy First

Accuracy overrides cost. Use the cheapest model that satisfies the required accuracy, risk level, modality, and context size. Do not choose a cheaper model if it materially increases the chance of incorrect implementation, unsafe command, data loss, security regression, or misleading output.

## Official Model IDs

Use these exact model IDs:

- GLM 5.2 OpenCode Go: `opencode-go/glm-5.2`
- MiniMax M3 OpenCode Go: `opencode-go/minimax-m3`
- DeepSeek V4 Flash Free OpenCode Zen: `opencode/deepseek-v4-flash-free`
- DeepSeek V4 Flash OpenCode Go paid fallback: `opencode-go/deepseek-v4-flash`
- MiMo V2.5 Free OpenCode Zen: `opencode/mimo-v2.5-free`
- MiMo V2.5 OpenCode Go paid fallback: `opencode-go/mimo-v2.5`
- GPT 5.6 Luna utility lane: `openai/gpt-5.6-luna`
- GPT 5.6 Terra delivery lane: `openai/gpt-5.6-terra`
- GPT 5.6 Sol assurance lane: `openai/gpt-5.6-sol`

GPT Expert tasks must use the OpenAI provider only. Do not use Zen bundle GPT-like models for GPT Expert tasks.

OpenAI-only mode uses Luna, Terra, and Sol only. Do not route OpenAI-only agents to Zen bundle models, OpenCode Go models, GLM, MiniMax, DeepSeek, or MiMo. If the OpenAI provider is unavailable for an OpenAI-only task, stop and ask.

## Fallback Chains

If a selected model is unavailable, rate-limited, over quota, degraded, missing required capabilities, or repeatedly fails, use the next safe fallback instead of improvising.

Fallback order by role:

- GLM hard engineering: `opencode-go/glm-5.2` -> ask user if unavailable.
- MiniMax coding: `opencode-go/minimax-m3` -> ask user if unavailable. GLM is never an availability fallback.
- DeepSeek Flash utilities: `opencode/deepseek-v4-flash-free` -> one retry with `opencode-go/deepseek-v4-flash` -> `opencode-go/minimax-m3` for bounded delivery or ask user. Never select GLM solely because Flash capacity is unavailable.
- MiMo visual parsing: `opencode/mimo-v2.5-free` -> `opencode-go/mimo-v2.5` -> `openai/gpt-5.6-terra` if OpenAI is available -> `opencode-go/minimax-m3` only for text-based follow-up when structured visual text is already available -> ask user.
- OpenAI-only Luna utility: Luna -> Terra -> ask user. Terra must retain the same bounded utility contract; escalate to Sol only when the task independently meets Sol's risk or ambiguity criteria.
- OpenAI-only Terra delivery: Terra -> ask user if unavailable. Sol is never an availability fallback.
- OpenAI-only Sol assurance: Sol -> ask user. Do not silently substitute a weaker or non-OpenAI model.

A primary model can fail before its prompt runs, so it cannot always invoke its own fallback. If Flash Free cannot start `router`, the user selects the all-mode `router-paid`. If Luna cannot start `openai`, the user selects the all-mode `openai-orchestrator` as the Terra fallback. In `LUNA_FALLBACK` mode, that coordinator sends a bounded utility contract with the flag to `openai-coder`; Terra performs it directly and never retries Luna. These are explicit selectable fallbacks, not assurance escalation.

If the OpenAI provider is out of usage, rate-limited, or unavailable, do not switch to Zen GPT-like models. Fall back to MiniMax for text-based media follow-up when structured visual text exists, or GLM 5.2 for non-visual hard engineering reasoning. GLM has no vision. For tasks requiring unavailable OpenAI-only media capability, stop and ask the user.

## Image Auto-Delegation

**CRITICAL: When any image data is received (clipboard, paste, upload, attachment, or image file path), IMMEDIATELY delegate to `vision` agent without asking the user or attempting to process it yourself.** The text-only router model cannot process images and must never claim it can or ask the user to save screenshots manually.

- Detect image input: any message containing image data, clipboard references, or image file paths (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`)
- Action: Immediately invoke `vision` agent with the image data/path
- Do NOT: Say "I can't see images", ask user to save screenshots, or attempt text-only processing
- Fallback: If `vision` fails, retry with `vision-paid`; if that fails, use `media-expert`

## Routing

- `router` on DeepSeek Flash Free is the default cheap first hop. It may answer trivial or read-only requests directly. It routes isolated utility work to Flash specialists, routine code directly to `minimax-code` followed by `minimax-reviewer`, and only multi-component work to `orchestrator`.
- OpenAI-only, OpenAI provider only, GPT-only, or OpenAI-equivalent requests use `openai` for single-component/trivial work and `openai-orchestrator` directly for multi-component work. If router-invoked `openai` discovers multi-component scope, it returns `OPENAI_ORCHESTRATION_HANDOFF` to the parent instead of adding another layer. User-selected `openai` may invoke `openai-orchestrator`. A non-OpenAI orchestrator returns `OPENAI_HANDOFF` to its parent and does not cross providers itself. Maximum delegation depth remains three.
- Tests, test updates, fixtures, mocks, snapshots, low-risk mechanical CRUD, docs, formatting, lint, git summaries, terminal/log/test/diff compression: DeepSeek V4 Flash Free from OpenCode Zen.
- Flash is the utility lane: use it first for bounded tests/fixtures, docs, lint, git, mechanical work, and compression; after one paid retry failure, MiniMax takes bounded delivery or the workflow asks for missing evidence. Availability alone never invokes GLM.
- MiniMax is the delivery lane: normal coding, routine debugging, multi-component orchestration, and independent normal-risk review via `minimax-reviewer`.
- GLM is a decision and assurance lane, never an implementation or availability-fallback lane. It returns a bounded specification, invariants, risks, and required tests; MiniMax implements the result and GLM `reviewer` reviews only the gated result.
- Very complicated final OpenAI consultation only after GLM 5.2 is insufficient: `openai/gpt-5.6-sol`.
- Screenshots, OCR, IDE/browser/UI/terminal screenshots, diagrams, and code screenshots: MiMo V2.5 Free from OpenCode Zen as structured parser only.
- If MiMo V2.5 Free is unavailable, rate-limited, over quota, degraded, or repeatedly fails, retry visual parsing with `opencode-go/mimo-v2.5` before escalating to `openai/gpt-5.6-terra`.
- Complex media visioning, complicated UI reasoning, mixed visual context, Figma-like interpretation, and multimodal debugging that MiMo cannot handle: `openai/gpt-5.6-terra`.

## Nested Specialist Delegation

Only task-enabled routers, orchestrators, and coders may delegate, and only through their configured task allowlists. Task-denied utilities, readers, vision/media agents, decision agents, and reviewers never invoke another agent: they return an exact handoff/status and evidence to their parent. The parent owns paid fallback, escalation, implementation assignment, and independent review.

When a task-enabled parent needs work outside its specialty, it delegates to the correct configured specialist:

- Test execution, test authoring, fixture updates, snapshot updates, and test-failure triage: delegate to `tests` first, then `tests-paid` if the free agent is unavailable or repeatedly fails.
- Formatting, import cleanup, lint-only fixes, and style-only repairs: delegate to `lint` first, then `lint-paid`.
- Git communication work such as commit grouping, commit messages, PR summaries, release notes, or commit creation: delegate to `git` first, then `git-paid`. Agents may inspect narrow `git status`, `git diff`, and changed-file lists when needed as direct evidence for their assigned implementation or review.
- Long terminal output, logs, compiler output, test output, and large diffs: delegate to `terminal-reader`, `log-reader`, or `diff-reader` first, then the matching paid fallback.
- Documentation-only follow-up work: delegate to `docs` first, then `docs-paid`.
- Visual parsing follow-up work: delegate to `vision` first, then `vision-paid`.

A coding or hard-engineering agent may run a narrow command itself only when it is immediate, low-volume evidence for its own assigned source change, such as a targeted unit test or formatter check. If the command output is long, the failure cause is unclear, repeated attempts are needed, git communication is requested, or the work becomes mostly tests/lint/docs/git/log compression, delegate to the relevant specialist before continuing.

For the general workflow, each delegation includes a task contract (goal, acceptance criteria, file scope, risk classification, and needed evidence) and has maximum depth three. Do not re-delegate the same task class. Before MiniMax or GLM reasons over a large log/diff, Flash readers produce a focused evidence packet: changed files, focused diff or summary, verification results, exact failures, test changes, and unresolved assumptions. MiniMax may make at most two report -> focused fix -> re-review cycles; then the assurance gate is met. Normal-risk executable changes use independent `minimax-reviewer`; GLM `reviewer` is mandatory only when the assurance gate is met. Docs-only, formatting-only, and clear fixture/snapshot-only changes do not need GLM review unless they independently meet that gate.

OpenAI-only workflows stay within three lanes: Luna is the bounded first hop and utility lane; Terra implements routine work and performs routine review; Sol makes only assurance-gated decisions and reviews. A child receives only a goal, acceptance criteria, file scope, and needed evidence. Use Luna compression before Terra/Sol reasoning; do not pass broad logs or full history. After one focused Terra report -> fix -> re-review cycle fails, the assurance gate is met. Sol returns a bounded specification, invariants, risks, and required tests; Terra implements that specification; an independent Sol reviewer reviews only the gated result. Do not route OpenAI-only work to DeepSeek, GLM, MiniMax, MiMo, Zen bundle models, or OpenCode Go models.

## Assurance Gate

Use GLM or Sol only when at least one explicit gate applies:

- architecture or cross-system design
- security, privacy, authentication, authorization, secrets, payments, permissions, or destructive operations
- migrations, persistence, data integrity, or irreversible data changes
- public API or schema compatibility
- concurrency or distributed state
- compliance or a production incident
- material ambiguity with materially different implementations
- confidence remains below 80 after focused evidence collection
- one focused Terra fix cycle or two focused MiniMax fix cycles has failed
- independent review of high-risk code authored by an assurance model

Ordinary behavior-changing or externally visible work is not, by itself, an assurance trigger. Assurance models do not edit, run commands, or delegate. They return decisions/specifications or review findings to the parent. The cheaper delivery model owns implementation and verification.

If GLM cannot resolve a genuinely gated decision from focused evidence, it returns `EXPERT_CONSULT` and the compressed packet to the parent. Only the parent may invoke `gpt-expert`; it rejects any request without both the explicit assurance gate and unresolved GLM decision, returns bounded guidance, and never edits or delegates.

## Compression Before Reasoning

Compress logs, terminal output, compiler output, CI output, test output, screenshots, and large diffs before sending them to reasoning models. Do not compress important source code, business logic, architecture, small relevant files, or security-sensitive logic unless explicitly requested.

Compression must preserve exact errors, file paths, line numbers, command names, versions, exit codes, failing test names, stack trace top frames, first caused-by section, repeated exception counts, and timestamps when relevant.

## Evidence

No agent may claim correctness without evidence from inspected files, command output, tests, official docs, schemas, or runtime behavior. Confidence is invalid without evidence and uncertainty.

Source-of-truth priority:

1. Repository source code
2. Lockfiles and package manifests
3. Tests
4. Official docs and schemas
5. Runtime output
6. Repository memory
7. Model memory

## Escalation

- 95+: continue.
- 80-95: continue and mention uncertainty.
- 60-80: reclassify with a focused evidence packet; escalate to GLM 5.2 only if the assurance gate is met, otherwise use bounded MiniMax delivery or ask.
- Below 60: stop and request assistance or stronger review.

If `opencode/deepseek-v4-flash-free` fails because of quota, rate limits, provider errors, or availability, retry once with `opencode-go/deepseek-v4-flash` for the same task class. If that retry fails, use MiniMax for bounded delivery or ask for the missing evidence/capability; do not invoke GLM solely for availability. If MiniMax is unavailable, ask the user. Escalate MiniMax to GLM only through the assurance gate. If GLM remains below 80 confidence on a very complicated task, ask for missing information or escalate to `openai/gpt-5.6-sol` only when that consultation independently meets the gate.

All normal-risk executable edits in the general workflow require independent MiniMax review through `minimax-reviewer`. GLM 5.2 `reviewer` is required only when the explicit assurance gate is met. GLM supplies a bounded specification to MiniMax and never implements directly. Review reports must be actionable and use the focused evidence packet. OpenAI-only review requirements are defined below and stay entirely within the OpenAI provider.

For OpenAI-only workflows, use the Luna-based `openai` selectable primary, `openai-orchestrator` for direct multi-component routing or user-selected `LUNA_FALLBACK`, `openai-coder` for Terra implementation or flagged bounded utility fallback, matching `openai-luna-*` agents for ordinary bounded utility work, and `openai-sol-*` agents only when the explicit assurance gate applies. Luna output that edits executable code needs independent Terra review. Terra changes receive Terra review for normal risk and Sol review only when gated. Sol supplies a bounded specification to Terra and never implements directly. The same report -> fix -> review loop applies, and every model stays within the OpenAI provider. If Terra is unavailable, ask the user; never substitute Sol for availability.

## Stop And Ask Rule

Stop and ask the user instead of continuing when:

- requirements are ambiguous and multiple implementations would be materially different
- a required model is unavailable and no safe fallback exists
- the task requires capabilities the current agent does not have and delegation is unavailable
- confidence is below 60
- required files, credentials, environment, or inputs are missing
- a command may be destructive or irreversible
- source code conflicts with repository memory or user instructions
- an agent would need to invent APIs, versions, product behavior, or security assumptions

When stopping, report what is blocked, what evidence was collected, why continuing would be unsafe, and the smallest question needed to proceed.

## Specialist Response Shape

Default to concise responses. For routine cheap-agent work, report only:

- Output
- Evidence
- Confidence
- Risks or Next Step, only when useful

Use a fuller Goal/Constraints/Assumptions/Plan/Output/Confidence/Evidence/Risks/Next Step shape only for high-risk work, complex debugging, architecture, review findings, or when the user asks for that structure.
