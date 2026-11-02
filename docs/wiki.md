# Project wiki

Living record for Claude Code Console. Update this file as requirements and decisions evolve; preserve superseded decisions and append dated history. PM coordinates edits so concurrent agents do not overwrite one another.

## Product requirements

### Existing product baseline

Source: README.md at commit e2503cb. This describes existing behavior, not newly approved requirements.

A local web console groups Claude Code sessions by project folder, shows sessions needing attention, activity and usage costs, and lets users interact with sessions through a browser. It runs locally using Node.js and the existing Claude login.

### Next deliverable

Not yet assigned. Before implementation, record the problem, intended users, scope, non-goals, acceptance criteria and verification plan here. Do not infer a feature backlog from team setup approval.

## Architecture and design

Existing README describes transcript watching/tailing, an in-memory session store, HTTP/SSE delivery, a browser UI and an Agent SDK runner. Verify against current source before relying on details.

For each change, document affected data models, system flows, interfaces, edge cases and failure behavior before writing code. Identify migration or compatibility needs where relevant. Record important choices as ADRs below.

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

### ADR template

Number and title; date; proposed/accepted/superseded status; context; options; decision; consequences; evidence and approval source. A superseding ADR links back to the earlier record.

## Decision history

- 2026-10-24: Admin approved a reusable six-agent engineering team, Claude Code developers and Codex specialists, repository-local progressive wiki, room discussions and PR-based code review. KISS, DRY, YAGNI and design-before-coding are required. No product feature scope has been approved yet.

- 2026-10-24: Admin approved consolidation to three agents and renaming eng-dev-1 to eng-dev. Preferred discussions moved to built-in Mattermost rooms after Slack and agent-only rooms did not meet the desired Console chat workflow.

## Verification record

Initial wiki is documentation only. Repository behavior and architecture have not been independently tested as part of team provisioning. Each subsequent PR must record its own relevant verification.

## Context status request — 2026-11-01 (CCC-CTX-01)

Admin requested context window status for each agent (sw_92042f9d3d52770463d7ea2a6ee2a549). Current baseline b3623b8 already exposes session.context and a Details bar/live percent. New work should expose context clearly for each session, preserving Claude/Codex semantics and explicit unknowns. Requirements/design pending helper evidence, early reviewer feedback and mandatory senior pre-plan advice; no implementation plan finalized yet.

Candidate criteria: known used/limit and remaining percentage visible per session; no false zero/full-free state for missing telemetry; consistent detail/list display; model changes and compaction update according to provider evidence; parent context never sums subagent totals. Subagent display feasibility must be checked before committing scope. No model price lookup or paid native tasks needed for this initial review.

PM owns docs/status.md and wiki edits. Task communications use the original request thread. Current owner-approved roster is eng-pm, eng-dev-mid, eng-helper, eng-dev-sr and eng-reviewer; old staffing above is historical and pending staffing docs PR #6 remains separate. Older scope/history in open PR #2 is preserved and not rewritten by this task.

## CCC-CTX-01 finalized design — 2026-11-01

Pre-plan senior checkpoint passed: updated advice sw_18dd90a5b1bd486f835063d5ed17748f supersedes senior's earlier subagent exclusion/model-rescaling suggestions. Early reviewer criteria sw_d834986f84c14ab486222bdb650cd163 incorporated. eng-dev-mid owns implementation; PM owns status/wiki.

Pin each measurement as {tokens|null, model, window|null, windowSource, at, stale}; snapshot percentage is nullable unless tokens finite/nonnegative and window finite/positive. Retain measurement model/window/time/source; model changes cannot retroactively rescale old readings. Claude uses that message's input+cache+output and known model-table window (explicit estimate source); unknown model window stays null, removing the 200K fallback. Codex uses last_token_usage.total_tokens and reported window/current turn model. Label last-reported request occupancy, not native TUI remaining capacity or auto-compaction thresholds. No new model capacity guesses.

Compaction uses valid nonnegative Claude postTokens including zero; missing count invalidates occupancy. Codex invalidates percentage until next usage. Reject context updates older than observation/compaction timestamps; do not alter existing spend dedupe. Child measurements use only that child's telemetry/model and never mutate parent context. Existing hidden/compaction-child/done-row visibility rules remain intact; absent evidence says context unavailable.

UI: compact explicitly labelled used percentage in session list; same shared formatter in Details/live line and existing child rows. Known token/limit/remaining/model/source/as-of text in accessible label/tooltip; unknown/compacted/over-limit meanings must also be visible without color/hover alone. Integer used percentages floor; visual bars clamp while text exposes over-limit usage and zero remaining. No overview changes, no summed parent/child/fork usage, no cumulative spend tokens. Existing modules/public folders and camelCase naming; malformed telemetry remains unknown and must not break UI.

Acceptance/verification: provider fixtures for independently missing usage/limit, zero/malformed data, unknown models, compaction with/without counts, model switch before/after measurement, replay/restart/old pre-compaction events, two children with unchanged parent, synthetic/error/copied Claude lines not moving context. Browser checks for known/unknown/compacted/over-limit states in both providers, list/detail/SSE consistency and child independence. Preserve 107-test baseline and existing Copy behavior; do not fold unrelated open PR fixes into this task. Independent exact-head QA plus mandatory senior completion checkpoint precede ready-for-human-merge status. Same-error-twice checkpoint applies if triggered. No merge/deployment approval inferred.

## CCC-CTX-01 ready-for-review — 2026-11-01

PR #8 verified OPEN at 15dff13b2263c0adda224f03d1ba2fa81fae5a64 (feat/context-status, base b3623b8). Developer reports pinned nullable context for both providers, compaction/replay/model correctness, independent child context and shared UI formatter, with README update. Reported 125 tests pass (107 baseline plus 18 context tests); no real browser/SSE checks performed yet. Developer message sw_96c81ffe357343bf9f9f1515d1c7a739.

State is ready-for-review, not done. PM requested independent exact-head code review + synthetic browser/SSE QA from eng-reviewer and mandatory completion advice from eng-dev-sr; both responses pending. Mid keeps the head stable and owns required fixes. No paid native tasks, merge, deployment or release authorized. Senior checkpoint advice supplements, not replaces, independent QA and human approval.

## CCC-CTX-01 interim independent blockers — 2026-11-01

Reviewer sw_61e66dd38dc049d6b02b64cda0681e75 independently passes 125/125 at 15dff13 but reproduces Codex old-measurement rescaling by window/task_started events (80/100 to 80/200 without new measurement, old window can yield 160%); old compaction replacing/invalidating newer readings in both providers; ignored Claude child compact_boundary; negative Claude usage fields summing into plausible known occupancy. Browser/SSE checks and exact PR evidence still in progress.

Mid assigned fixes and store-ingestion regression cases: preserve pinned measurement separately from mutable turn hints, monotonic compaction and usage guards for parent/child, validate every numeric usage component. Senior completion advice must account for these blockers and recheck corrected head. No review/completion clearance or merge authorization.

## CCC-CTX-01 corrected head for recheck — 2026-11-01

PR #8 verified OPEN at a667635e12d6c1310eb07bd045fc0e02c020e510. Developer sw_a8d358f7d4634cc4badb523337de465a reports 131 tests and six added store-ingestion regressions, with fixes for Codex pinned-window mutation, stale compaction, Claude child compaction and per-component malformed usage. These are submitted claims, not independent clearance. Reviewer is assigned original repro recheck plus remaining synthetic browser/SSE; senior completion checkpoint updated to this head. Any repeated same failure after fixes triggers the mandatory senior recurrence checkpoint. No merge/deploy/release authorization.
