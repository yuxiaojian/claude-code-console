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
