# Project wiki

Living record for Claude Code Console. Update this file as requirements and decisions evolve; preserve superseded decisions and append dated history. PM coordinates edits so concurrent agents do not overwrite one another.

## Product requirements

### Existing product baseline

Source: README.md at commit e2503cb. This describes existing behavior, not newly approved requirements.

A local web console groups Claude Code sessions by project folder, shows sessions needing attention, activity and usage costs, and lets users interact with sessions through a browser. It runs locally using Node.js and the existing Claude login.

### Next deliverable

### Codex CLI parity — approved for implementation

Request: Admin asked in claude-code-console-local on 2026-10-24 to support Codex agents the same as Claude Code agents and explicitly required approval before implementation (message sw_09d95bfe930a0d1076c5de9a9bb86c6d). Admin subsequently approved implementation in message sw_30ba6fdf2abce704bb1a5fe81c2cecfa after confirming the four scope decisions. Merge, deployment and release remain subject to separate approval.

Problem and users: People using both local coding agents need one project-oriented console to monitor sessions and interact with them.

Proposed scope:
- Discover Codex local session history alongside Claude sessions, respecting the existing recent-history window and configured provider directories.
- Group both providers under the same existing PA/project rules; label the provider on sessions and choose a provider when starting a session.
- Show conversation history, activity/tools, attention status, subagent relationships, token/context usage and notifications where the source supplies evidence.
- Start, resume, fork, send follow-ups, interrupt and disconnect Codex sessions from the browser; handle native approvals and questions.
- Keep model and permission defaults separate per provider while preserving current Claude settings and behavior.
- Use existing local Codex authentication/configuration. Do not add account/token management as part of parity.

Scope questions answered by Admin on 2026-10-24 (message sw_ffe25c34cb2da4ddc8b770c72278ba23). Original questions retained for traceability:
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
- Status: Accepted for implementation with the revisions in “Independent design gate cleared” and “Final developer revision and PM design sign-off” below. Historical original status: Proposed; implementation awaited Admin approval.
- Context: Claude assumptions currently span discovery, state, execution, settings and UI; Codex uses distinct records and policy concepts.
- Options: Duplicate the console; force Codex through Claude event/policy shapes; share the console with small provider-specific adapters.
- Original proposed decision (retained for history): Share UI/project infrastructure, namespace session identities, and preserve native capabilities/policies. Prefer Codex app-server for interactive execution, subject to installed-version verification.
- Accepted decision: Use small src/codex adapters and native app-server, provider-qualified identities, bounded ancestry, live-owned continuation only and explicit incomplete usage, as detailed in the final design records below.
- Consequences: Some controls and usage fields differ by provider; missing evidence must remain unknown. Adapter boundaries should follow actual needs, avoiding a general plugin framework.
- Approval source: Admin implementation approval sw_30ba6fdf2abce704bb1a5fe81c2cecfa; PM design sign-off sw_56862500a3e840c29b9c0ef0005501ed; independent design sign-off sw_e7d2c0060de64c50a74c4140546ea05a. Historical original approval field: None yet; initial request sw_09d95bfe930a0d1076c5de9a9bb86c6d required prior approval.

### ADR template

Number and title; date; proposed/accepted/superseded status; context; options; decision; consequences; evidence and approval source. A superseding ADR links back to the earlier record.

## Decision history

- 2026-10-24: Admin approved a reusable six-agent engineering team, Claude Code developers and Codex specialists, repository-local progressive wiki, room discussions and PR-based code review. KISS, DRY, YAGNI and design-before-coding are required. No product feature scope has been approved yet.

- 2026-10-24: Admin approved consolidation to three agents and renaming eng-dev-1 to eng-dev. Preferred discussions moved to built-in Mattermost rooms after Slack and agent-only rooms did not meet the desired Console chat workflow.

## Verification record

The dated entries below preserve the sequence of proposals, approvals and verification. Earlier pending gates and unverified claims describe their state at the time; the latest clearance record governs current delivery status.

Initial wiki is documentation only. Repository behavior and architecture have not been independently tested as part of team provisioning. Each subsequent PR must record its own relevant verification.

- 2026-10-24: Codex parity requirements review prepared; questions and proposed criteria await Admin response. No implementation approved. GitHub identity yuxiaojian and ADMIN access verified; PR #1 remains open at 7738e3c. This scope branch builds on that unmerged documentation branch.

Reviewer input (2026-10-24, room message sw_61327e9f629d49d781dab818c8ec9642): define external ownership conservatively; only control console-owned processes. Explicitly verify native configuration precedence, provider/version capabilities, archive discovery, restart/replay, compaction and browser reconnect. Never silently translate Claude modes or persistent approval scopes into Codex policies. Runtime compatibility remains unverified.

## Confirmed Codex scope decisions — 2026-10-24

Admin confirmed: Codex CLI only; external sessions are observe-only, with browser control limited to console-owned sessions and safe forks; dollar values may be API-equivalent estimates with unavailable values shown as unknown; controls use native provider policies and explain unsupported actions. Desktop/IDE and cloud sessions are outside this scope. Source: room message sw_ffe25c34cb2da4ddc8b770c72278ba23.

These answers resolve the scope questions. Admin approved implementation in message sw_30ba6fdf2abce704bb1a5fe81c2cecfa. ADR-003 is the proposed technical direction; eng-dev and eng-reviewer must verify installed-version capabilities before committing to detailed interfaces.

## Historical delivery state at implementation authorization — Codex CLI parity

This snapshot is superseded by “Independent review/QA cleared; human merge gate” below. Its next gate is historical, not the current task state.

- Implementation authorized by Admin, 2026-10-24, message sw_30ba6fdf2abce704bb1a5fe81c2cecfa.
- eng-dev: implementation and tests in a dedicated task worktree/branch; report concrete model/flow/capability design before coding and raise material scope gaps to PM.
- eng-reviewer: early independent design/acceptance review, then exact-head PR review and QA; recheck fixes.
- eng-pm: scope, architecture decisions and serialized wiki updates; coordinate development through review to human merge approval.
- Existing documentation PRs #1 and #2 remain unmerged. Implementation must account for their documentation dependency without merging either automatically.
- Next gate: developer capability/design proposal and reviewer feedback. No merge, deployment or release is authorized by the implementation approval.

## Implementation design review — 2026-10-24

Developer design: room attachment codex-parity-design.md, message sw_6ddfa84301c74620a8150adabc2770d9. Developer reports live probes against Codex 0.164.0 for lifecycle/locking/command approvals; interruption, other approval types, subagents and compaction still require meaningful verification. These are reported findings, not independent QA results.

PM decisions within approved scope:
- Token usage with unknown Codex dollars is acceptable for this PR; no speculative price table. Incomplete totals remain explicit. Any future pricing table requires official verified sources.
- Explicit workspace preset (on-request plus workspace-write), read-only and untrusted choices are acceptable; never label on-request as approval before every tool. Display native effective policy, respect managed constraints, preserve other native configuration, and label changes as next-turn behavior.
- Superseded ownership proposal: allow an explicit resume attempt under unknown ownership relying on native writer enforcement. Rejected after independent design review; the stricter rule below governs.
- Provider plus native session id must define identity; UUID version assumptions and dropping collisions are rejected.
- Fork ancestry reads need bounded offsets, cycle/missing-parent handling and safe parent resolution. Copied/referenced history cannot count as new spend even outside the discovery window.
- Small modules under src/codex are accepted as the concrete folder direction instead of the earlier tentative src/providers layout. Retain console-origin filtering across restarts. Reviewer must assess decline-only MCP elicitation and incomplete subagent/compaction evidence before design sign-off.

Next gate: reviewer resolves remaining design blockers, then development proceeds under existing implementation authorization. No new human approval is required for these routine design choices. Merge/release remain separately gated.

## Ownership correction after independent review — 2026-10-24

Review source: sw_36a07b70429c40269abeb018ef9fb74c. Supersedes PM's earlier unknown-ownership resume allowance in sw_080749d9e4704500a4bdc02b2be425a0. A writer lock protects integrity but does not prove permission to take control.

- Full control requires a live console-owned run. Historical/non-owned resume requires affirmative exclusive console ownership; no-lock, failed/missing lsof, elapsed time or console origin alone is insufficient.
- Without a demonstrated reliable ownership mechanism, historical threads (including console-created threads after child exit/restart) are observe-only with an explicit safe-fork action. Never silently substitute fork for resume; explain unavailable resume.
- Ownership races and native lock conflicts stop cleanly, without replaying turns, removing locks or controlling external processes.
- Developer must revise the plan for reviewer sign-off before coding. Include identity, bounded nested ancestry/missing parent handling, usage deduplication/missing IDs, reversed parent/subagent discovery, provider-specific failure isolation, sanitized errors and unsupported protocol shapes.
- This is a conservative design rule within approved external observe-only scope. Any mechanism enabling historical resume must receive design review before use.

## Final developer revision and PM design sign-off — 2026-10-24

Source: eng-dev confirmation sw_e095770a5cb747f898b62d48be8e33d9. PM accepts the revised design, subject to independent reviewer sign-off before coding.

- Codex continuation is limited to live console-owned runs. All other sessions, including console-created history after exit/restart, are observe-only with explicit safe fork. Ineligible requests return 409 before thread/resume or turn/start; tests assert neither native call occurs.
- Usage requires native owner matching the file's session and a response id. Missing/mismatched owners or missing response ids are skipped and reported as incomplete at session and total levels. Per-session response-id sets do not evict entries during retention; pruning a session releases its dedupe state. Reverse discovery and replay must not affect accounting.
- Browser errors use fixed safe categories. Any optional native detail passes tested secret/path redaction before clipping; position-zero secrets must be covered.
- Display effective native policies and explain workspace writes may run without asking, with native rules and managed settings still applying.
- Developer corrected the initial TUI probe: a resumed TUI acquired its daemon writer lock without typing, observed at about 0.9 seconds. The earlier first-write claim was incorrect due to slow daemon installation. This reported correction does not alter conservative ownership rules; independent runtime QA remains pending.
- Next state: await independent reviewer confirmation, then implementation and exact-head review/QA. Merge/release remain gated by Admin approval.

## Independent design gate cleared — 2026-10-24

eng-reviewer granted design sign-off in sw_e7d2c0060de64c50a74c4140546ea05a. Implementation may proceed under Admin's existing approval. The accepted design comprises the original proposal plus subsequent identity/ancestry/restart and final ownership/usage/error/policy corrections; superseded proposals above remain historical only. ADR-003 is accepted for this implementation with those corrections and src/codex folder layout.

Verify native token owner fields against captured Codex 0.164.0 records. Missing owner evidence or conflicting thread_id/session_id values must be skipped and flagged incomplete. Prefer fixed safe error messages. Code review and independent QA remain pending the exact implementation PR head; no merge/release approved.

## Development handoff to independent review — 2026-10-24

Implementation PR #3 is open at f4061d988efd9ad5936ab389026ee1c53715f3e9, based on main e2503cb; verified via GitHub. Developer handoff: sw_41b3d4d878d44d2ea766d6d80c46c8ff. PRs #1/#2 remain separate documentation dependencies.

Developer reports 101/101 tests passing (45 existing, 56 new; three original assertions updated), real Codex 0.164.0 smoke for approval cancellation/duplicate response, interrupt, disconnected-session rejection, fork history and unknown/incomplete costs. Screenshots and smoke log were posted to the room; PM has not independently verified their runtime assertions.

Live gaps disclosed: file-change/permissions/questions/MCP elicitation, steering, subagents and compaction have schema/fixture evidence only. Real Claude SDK smoke is missing; developer asked to install the declared dependency and attempt a minimal disposable authenticated smoke, or report a concrete blocker.

eng-reviewer owns independent exact-head code review and QA, findings and rechecks. Check default-policy/config precedence wording and authoritative token-owner handling against the accepted design. Current state: review/QA pending; implementation completion and passing developer tests do not authorize merge/release.

## Independent QA interim findings — 2026-10-24

Reviewer message sw_e0cac263428e4c039cbce859fc7c15a2 reports independent 101/101 suite pass at PR #3 head f4061d9, plus two reproduced runtime defects with injected app-server responses: failed startup removes the run without terminating its child; rejected turn/interrupt is swallowed and Stop reports success. Reviewer is preparing exact-head PR evidence; review is not approved.

Both are blocking. eng-dev is assigned owned-process cleanup and truthful interruption error handling with targeted regression tests. eng-reviewer must recheck the new head and relevant lifecycle behavior. Real-Claude smoke/default-policy clarification remain outstanding. No merge/release authorization.

## PR #3 changes required — 2026-10-24

Independent review at f4061d9: https://github.com/yuxiaojian/claude-code-console/pull/3#issuecomment-6390271014 (room sw_d0cc614bc2e940029ccc19e20befe87e). Four reproduced blockers: P1 startup orphan child; P2 swallowed interrupt failure; P2 next-message policy promise while steering under old policy; P2 all-skipped usage shown as zero in rows/live line. eng-dev must fix and add focused regression tests; eng-reviewer rechecks exact updated head.

Policy timing must either defer steering until the new turn/policy or explicitly describe next-new-turn semantics and show effective current policy. Unknown/incomplete usage must remain consistent across all views. Reviewer independently ran 101 tests and read the supplied smoke log; native paid/browser smoke and real-Claude chat were not independently rerun. No merge/release approval.

## Claude smoke and policy clarification — 2026-10-24

Developer message sw_b22d16f7458e402ea1634a086810811a reports successful real-Claude SDK smoke at unchanged PR #3 head f4061d9 after npm ci: approval denied/no file, duplicate answer 404, same-process follow-up, disconnect/resume, bare-id compatibility, three-turn transcript and reported Claude cost. This closes the missing developer smoke evidence; reviewer has not independently rerun it. A transient post-disconnect 409 while the process exits is reported as existing main behavior, not verified as a new regression.

Developer clarified every Codex start/fork sends an explicit preset; changed modes apply on next turn/start, unchanged turns preserve native configuration. Safe actionable errors for recognized managed-policy incompatibility are required in PR #3, not deferred; unknown causes remain generic rather than falsely classified. The four independent review blockers remain open pending corrected exact head/recheck.

## Fix head submitted for recheck — 2026-10-24

Developer message sw_9531e6d88f6f46ea93c7eff2a22ecf61 submits PR #3 head 61abcc2dee340c1ff7f5bebd9445ecd94e0e8162 with reported 107/107 tests. Claimed fixes: child cleanup on all startup phases/timeouts, truthful interrupt failure with active state preserved, refusal to steer while a policy change is pending, unknown dollar cost for skipped usage, effective-policy fallback notices and categorized managed-policy rejection. An additional RPC-timeout timer issue is fixed. All claims await independent recheck.

eng-reviewer is asked to verify original repros plus late RPC replies/timeouts and policy rejection before steering, and assess live-smoke reruns warranted by the changes. Managed requirements behavior is fake-tested only; developer could not exercise it without admin configuration, and no machine/admin setup changes are authorized. Original live-smoke evidence is at f4061d9, not the new head. Current gate remains independent review/QA; no merge/release approval.

## Independent review/QA cleared; human merge gate — 2026-10-24

Reviewer message sw_3f3b93a820b94924a0f6eba0426cbcf7 clears PR #3 at 61abcc2dee340c1ff7f5bebd9445ecd94e0e8162. Evidence: https://github.com/yuxiaojian/claude-code-console/pull/3#issuecomment-6390351785. All four findings resolved; no remaining blockers identified. Independent 107/107 suite, original failure probes and diff check pass. Synthetic Chrome checks pass provider-id collisions, observe-only UI, explicit fork, unknown-cost rendering and API rejection before runner calls, without page errors.

Residual limitations: managed-policy messages/notices have review/fixture coverage, not live managed-requirements verification. Other previously disclosed native capabilities remain schema/fixture-only. Developer also reran the live Codex smoke at 61abcc2 (room sw_ebf10d5ca83f4bbfa2c0f70bc2db2630); Claude smoke remains at f4061d9. No independent native live smoke is claimed.

Development and independent review/QA gates are complete for this exact implementation head. Await Admin's explicit merge approval; no merge, deployment or release performed. Documentation PR #2 includes this record and depends on still-open #1; final documentation review is requested separately.

PM accepts explicit refusal, preserved draft text and retry guidance when a policy change is pending during an active turn; automatic deferred sending is unnecessary. This avoids sending under the old policy and is covered by independent recheck (developer clarification sw_ba36164b2df141a2a10bd5d03c6c2407).

## Current delivery update and Copy session ID task — 2026-10-24

GitHub verification: PR #1 is merged; PR #3 merged as 96465d73508852c4717abb28e073f5f34d44d24b at 2026-10-25T02:52:13Z (2026-10-24 local date). Those merges were observed, not performed by PM. Earlier pending-merge entries remain historical. PR #2 remains open; independent documentation review cleared c5339e0 before this update.

User authorized Copy session ID in Details (sw_aaddf267d536a1e9132f8c29bef60432). Scope/acceptance: explicit accessible Copy button, native ID without provider prefix for Claude/Codex, selectable text, click/Enter/Space, success feedback and clipboard failure/unavailable manual-selection guidance. eng-dev owns implementation in a separate worktree/branch; eng-reviewer owns independent exact-head review/QA. No merge/deployment authorization inferred from the request.

PR #4 is open at 5c4062928878a96b9ee1d54889fade55f60e11f6, based on main after PR #3. Developer reports 107 tests and Chromium clipboard readback/fallback/focus checks passing. Implementation reuses the ID node and defers renders during selection because live rerenders dropped manual selection. Reviewer must check clearing selection, route changes and session removal do not stall updates or show stale details, as well as the requested copy behavior. Current Copy task gate: independent review/QA pending, then human merge approval.

## Copy session ID independent clearance — 2026-10-24

Reviewer sw_8e82f04f7c4148c9b65fc149764487cb clears PR #4 at 5c4062928878a96b9ee1d54889fade55f60e11f6 with no blockers. Evidence: https://github.com/yuxiaojian/claude-code-console/pull/4#issuecomment-6394156676. Independent Chrome clipboard readback confirms exact native IDs for Claude/Codex via click/Enter/Space, feedback timeout, focus retention and rejected/missing clipboard manual-selection fallback through rerender. 107/107 tests pass; diff/checkout clean. Synthetic data only; no native sessions changed. Human merge approval requested; no merge/deploy/release performed by PM.

GitHub state correction: PR #4 was already MERGED at the reviewed head when checked. The room merge-approval request was stale and promptly corrected; PM did not perform the merge. Running-app update/restart is not claimed.

## Copy selection regression — prior clearance superseded

Reviewer sw_4b77e2591fa6472e99bbf084b215cc1c independently reproduced P2 at 5c40629: selected ID text blocks rerender during hash/history navigation or selected-session removal, leaving stale Details/Copy controls. Finding: https://github.com/yuxiaojian/claude-code-console/pull/4#issuecomment-6394161744. Earlier overall PR #4 clearance is superseded; clipboard/keyboard and suite evidence remain valid. PR #4 is already merged, observed before this finding; no unmerge is attempted.

eng-dev owns a focused corrective PR from current main in a separate worktree/branch under the authorized Copy task. Selection hold must apply only to same-session Details updates while that session exists; navigation/back-forward, removal and locked/error states bypass it. eng-reviewer independently rechecks these edges, correct Copy target, and preserved same-session selection/fallback. Current gate: corrective implementation and exact-head QA pending. No merge/deploy/release authorized. Temporary user workaround: clear selection before navigating.

## Corrective PR packaging and remaining guard cases

Developer submitted f6e85200854697a5509be9170a6134bd00d6ef97 on the prior Copy branch with route-change-only guarding (sw_e62ec152404f4f94a18aeb9f7820fbca). GitHub confirms PR #4 remains merged at 5c40629, merge b3623b878d9ba62577cd124971c5d5bdd4e9c043; no corrective PR is open yet. Pushing the old branch does not update main. Developer is instructed to use a new task branch/worktree and corrective PR from current main.

Route-change-only guarding is insufficient for selected-session removal and locked/error views at an unchanged URL. Those cases, active Details identity and retained same-session selection must be verified before clearance. Corrective gate remains open; no new merge/deploy authorization.
