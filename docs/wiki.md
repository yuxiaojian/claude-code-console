# Project wiki

Living record for Claude Code Console. Update this file as requirements and decisions evolve; preserve superseded decisions and append dated history. PM coordinates edits so concurrent agents do not overwrite one another.

## Product requirements

### Existing product baseline

Source: README.md at commit e2503cb. This describes existing behavior, not newly approved requirements.

A local web console groups Claude Code sessions by project folder, shows sessions needing attention, activity and usage costs, and lets users interact with sessions through a browser. It runs locally using Node.js and the existing Claude login.

### Next deliverable

### Codex parity review — proposed, awaiting Admin approval

Request: Admin asked in claude-code-console-local on 2026-10-24 to support Codex agents the same as Claude Code agents and explicitly required approval before implementation (message sw_09d95bfe930a0d1076c5de9a9bb86c6d). This authorizes requirements review only. No implementation assignment has been issued.

Problem and users: People using both local coding agents need one project-oriented console to monitor sessions and interact with them.

Proposed scope:
- Discover Codex local session history alongside Claude sessions, respecting the existing recent-history window and configured provider directories.
- Group both providers under the same existing PA/project rules; label the provider on sessions and choose a provider when starting a session.
- Show conversation history, activity/tools, attention status, subagent relationships, token/context usage and notifications where the source supplies evidence.
- Start, resume, fork, send follow-ups, interrupt and disconnect Codex sessions from the browser; handle native approvals and questions.
- Keep model and permission defaults separate per provider while preserving current Claude settings and behavior.
- Use existing local Codex authentication/configuration. Do not add account/token management as part of parity.

Questions for Admin:
1. Is the initial target local Codex CLI sessions, or must locally stored desktop/IDE sessions also be included? Remote/cloud sessions would need separate scope.
2. May Codex dollar values be explicitly labelled list-price estimates when available, with unknown/unavailable values shown honestly rather than treated as actual subscription billing?
3. May provider-native controls differ where Codex has no exact Claude equivalent, with unavailable actions explained in the UI?

Proposed acceptance criteria:
1. Both providers appear in a shared project without session-id collisions; Claude-only installations and existing saved defaults continue to work.
2. Historical and new Codex conversations render incrementally without duplicate messages or fork/subagent usage; partial or unsupported records do not break other sessions.
3. Console-owned Codex sessions support the lifecycle actions above. Active external sessions are not written to concurrently; unknown ownership is represented conservatively.
4. Approval/question cards reflect native requests and scopes. Denials, interruption, stale responses and disconnects cannot accidentally grant permissions or replay a turn.
5. Provider-specific models and policy controls are validated against the supported installed version. Missing Codex/login and unsupported capabilities have actionable errors.
6. Costs distinguish estimates, reported amounts and unknown values; incomplete totals cannot silently imply full coverage.
7. Existing access-token, origin/host checks and safe transcript rendering remain effective for Codex routes.

Verification proposal: fixture-based ingestion and lifecycle/approval protocol tests, existing Claude regression tests, and independent reviewer verification at an exact PR head. A live local smoke test will require a working Codex login; no agent task was run during this review.

Non-goals proposed for this request: remote/cloud orchestration, cross-provider conversation conversion and a package/repository rename. These are scope suggestions, not accepted exclusions.

## Architecture and design

Existing README describes transcript watching/tailing, an in-memory session store, HTTP/SSE delivery, a browser UI and an Agent SDK runner. Verify against current source before relying on details.

For each change, document affected data models, system flows, interfaces, edge cases and failure behavior before writing code. Identify migration or compatibility needs where relevant. Record important choices as ADRs below.

### Proposed provider integration

Current source baseline e2503cb is Claude-specific across CLI wiring, watcher/store/transcript, live-process detection, runner, API and browser settings. Share project grouping, tailing, HTTP/SSE transport and rendering where appropriate; isolate provider event parsing and execution behind small adapters. Session identity must include provider plus native session id. Keep capability and availability data explicit rather than a single global chat flag.

Candidate Codex runtime: local app-server, whose documented protocol supports thread start/resume/fork, streamed events, interruption, approvals and user input. Validate against installed Codex 0.164.0 before accepting a minimum version. Local transcript discovery, external-process ownership, subagent relationships and usage semantics still need design verification; protocol documentation does not establish complete parity for arbitrary external sessions.

Naming/folders proposed: use existing camelCase fields and kebab-case provider ids (`claude`, `codex`); provider modules under `src/providers/` only where needed; retain shared HTTP/SSE and project helpers in their current modules. Browser code stays in `public/`; tests in `test/`. Provider errors should carry provider, operation and a safe actionable message through existing JSON/SSE error handling, without credentials or raw auth configuration. These conventions remain proposed until design approval.

Official source: https://developers.openai.com/codex/app-server (reviewed 2026-10-24). This is a requirements review, not a validated integration.

## Engineering conventions

- Follow repository instructions and established patterns; inspect the relevant code before changing it.
- KISS: choose the simplest design that meets approved requirements.
- DRY: remove meaningful duplication through cohesive modules; avoid speculative abstraction.
- YAGNI: do not build capabilities for hypothetical future requirements.
- Document actual naming patterns, folder responsibilities and error-handling rules as they are verified. These details have not yet been inventoried.
- Each writing task gets a separate Git branch and worktree. Never run concurrent writers in the same checkout.
- Commit and push task branches on owner-controlled repositories; review code and accompanying documentation through PRs.
- Review and QA evidence must identify the exact PR commit. Rerun relevant checks after material changes.
- Merging, releases and deployments require Admin's explicit approval.

## Team and workflow

- eng-pm (Codex): combined PM and architect; requirements, acceptance criteria, design, architecture, ADRs, coordination and wiki edit ownership.
- eng-dev (Claude Code): sole developer; implementation, tests and PRs. Renamed from eng-dev-1.
- eng-reviewer (Codex): combined independent code reviewer and QA; early acceptance/design feedback, PR findings, acceptance verification and reproducible defect evidence.

The former eng-architect, eng-dev-2 and eng-qa agents are stopped with history preserved. Do not assign them new tasks.

Discuss project work in claude-code-console-local; cross-project intake and progress belong in engineering-local. Both are private built-in Mattermost rooms accessible inside Switch Console. Earlier Slack and agent-only rooms retain history but are superseded for new discussions.

Involve eng-reviewer when defining testable acceptance criteria and substantial designs, then independently review and test the exact implementation PR head. Route fixes back to eng-dev and recheck relevant changes. Human approval is required to merge or release. Record lasting decisions here. Approve additional project/task rooms before creation.

## Architecture decision records

### ADR-001: Keep a progressive repository wiki

- Date: 2026-10-24
- Status: Accepted by Admin in team setup discussion.
- Context: One reusable engineering team will work across multiple repositories and needs durable, project-specific requirements and decisions.
- Options: Chat-only records; external wiki; a versioned wiki inside each repository.
- Decision: Maintain docs/wiki.md with current PRD, architecture, conventions, numbered ADRs and dated history. Commit and push updates on Admin-owned repos; use PRs for review.
- Consequences: Decisions travel with the code and can be reviewed. PM must coordinate concurrent edits. Superseded decisions remain traceable.

### ADR-002: Consolidate into three agents

- Date: 2026-10-24
- Status: Accepted by Admin; supersedes the original six-agent staffing arrangement.
- Context: Admin requested fewer agents with combined responsibilities.
- Options: Keep six specialists; combine adjacent responsibilities into three agents.
- Decision: eng-pm combines PM and architecture; eng-dev is the sole Claude Code developer; eng-reviewer combines independent code review and QA. Stop the three redundant agents and preserve their history.
- Consequences: Fewer handoffs; review and QA remain independent of implementation. Reviewer participates early in acceptance criteria/design and verifies exact PR commits.

### ADR-003: Provider adapters and native Codex runtime

- Date: 2026-10-24
- Status: Proposed; implementation awaits Admin approval.
- Context: Claude assumptions currently span discovery, state, execution, settings and UI; Codex uses distinct records and policy concepts.
- Options: Duplicate the console; force Codex through Claude event/policy shapes; share the console with small provider-specific adapters.
- Proposed decision: Share UI/project infrastructure, namespace session identities, and preserve native capabilities/policies. Prefer Codex app-server for interactive execution, subject to installed-version verification.
- Consequences: Some controls and usage fields differ by provider; missing evidence must remain unknown. Adapter boundaries should follow actual needs, avoiding a general plugin framework.
- Approval source: None yet; request sw_09d95bfe930a0d1076c5de9a9bb86c6d requires prior implementation approval.

### ADR template

Number and title; date; proposed/accepted/superseded status; context; options; decision; consequences; evidence and approval source. A superseding ADR links back to the earlier record.

## Decision history

- 2026-10-24: Admin approved a reusable six-agent engineering team, Claude Code developers and Codex specialists, repository-local progressive wiki, room discussions and PR-based code review. KISS, DRY, YAGNI and design-before-coding are required. No product feature scope has been approved yet.

- 2026-10-24: Admin approved consolidation to three agents and renaming eng-dev-1 to eng-dev. Preferred discussions moved to built-in Mattermost rooms after Slack and agent-only rooms did not meet the desired Console chat workflow.

## Verification record

Initial wiki is documentation only. Repository behavior and architecture have not been independently tested as part of team provisioning. Each subsequent PR must record its own relevant verification.

- 2026-10-24: Codex parity requirements review prepared; questions and proposed criteria await Admin response. No implementation approved. GitHub identity yuxiaojian and ADMIN access verified; PR #1 remains open at 7738e3c. This scope branch builds on that unmerged documentation branch.

Reviewer input (2026-10-24, room message sw_61327e9f629d49d781dab818c8ec9642): define external ownership conservatively; only control console-owned processes. Explicitly verify native configuration precedence, provider/version capabilities, archive discovery, restart/replay, compaction and browser reconnect. Never silently translate Claude modes or persistent approval scopes into Codex policies. Runtime compatibility remains unverified.
