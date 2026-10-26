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

- eng-pm (Codex): PM and architect; requirements, design, ADRs, coordination and wiki edit ownership.
- eng-dev-mid (Claude Sonnet): main implementation flow, tests, documentation, PRs and fixes.
- eng-helper (Claude Haiku): parallel file/document research with source evidence and small assigned errands. Edits require explicit task scope and isolated working files.
- eng-dev-sr (Claude Opus 5.5): senior adviser, renamed from eng-dev. Reserve its involvement for the checkpoints below rather than routine calls.
- eng-reviewer (Codex): independent code review and QA, including early acceptance criteria/design feedback and verification against exact PR heads.

### Opus checkpoints

1. Before finalizing a plan: submit requirements, proposed design, edge cases and tradeoffs.
2. When the same error occurs twice in a task: submit the error, reproduction, two attempts and evidence; obtain diagnosis before repeating the approach.
3. Before declaring completion: submit the PR/diff, exact commit, test and acceptance evidence, review findings and remaining limitations.

Sonnet or PM sends a concise targeted request to eng-dev-sr and waits for its advice before crossing each applicable checkpoint. PM records the result in durable task state, the wiki or PR. Opus advice supplements independent review/QA and does not authorize merging or releasing.

Discuss project work in claude-code-console-local; cross-project intake and progress belong in engineering-local. These are the preferred built-in Mattermost rooms in Switch Console. Use separate branches/worktrees for writing tasks; keep lasting decisions here. Human approval remains required for merges/releases and additional rooms. Retired eng-architect, eng-dev-2 and eng-qa remain stopped.

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

### ADR-003: Route work by model and reserve Opus for checkpoints

- Date: 2026-10-25
- Status: Accepted by Admin in the team setup chat; supersedes ADR-002 staffing.
- Context: Admin wants Sonnet to handle the main coding flow, Haiku to research in parallel, and Opus to advise on significant decisions without routine Opus calls.
- Options: One developer model for everything; specialist model routing with explicit escalation checkpoints.
- Decision: Rename eng-dev to eng-dev-sr and pin Opus 5.5; add eng-dev-mid using Sonnet and eng-helper using Haiku. Require Opus before plan finalization, after a repeated error twice, and before completion. Keep PM and independent reviewer/QA on Codex.
- Consequences: Lower-cost models handle routine work; checkpoint requests need concise evidence and a response before proceeding. Claude Sonnet/Haiku model aliases follow provider resolution. Bypass stays disabled.

### ADR template

Number and title; date; proposed/accepted/superseded status; context; options; decision; consequences; evidence and approval source. A superseding ADR links back to the earlier record.

## Decision history

- 2026-10-24: Admin approved a reusable six-agent engineering team, Claude Code developers and Codex specialists, repository-local progressive wiki, room discussions and PR-based code review. KISS, DRY, YAGNI and design-before-coding are required. No product feature scope has been approved yet.

- 2026-10-24: Admin approved consolidation to three agents and renaming eng-dev-1 to eng-dev. Preferred discussions moved to built-in Mattermost rooms after Slack and agent-only rooms did not meet the desired Console chat workflow.

- 2026-10-25: Admin approved the Sonnet/Haiku/Opus routing and eng-dev-sr rename; instructions and active local rooms updated. ADR-003 supersedes three-agent staffing.

## Verification record

Initial wiki is documentation only. Repository behavior and architecture have not been independently tested as part of team provisioning. Each subsequent PR must record its own relevant verification.
