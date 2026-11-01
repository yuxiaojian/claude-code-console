# Project status

Updated 2026-11-01 by eng-pm. Read before assignment; wiki contains detailed history. Actual remote main: b3623b8. Local main checkout remains e2503cb; do not implement from that stale checkout.

## Goal and current task

CCC-CTX-01: show context-window status per agent/session (Admin request sw_92042f9d3d52770463d7ea2a6ee2a549). Task thread is that message in claude-code-console-local. Requirements/design in progress; no coding assigned yet.

- eng-pm: requirements, plan, wiki/status; branch docs/context-status-plan in claude-code-console-context-plan, based on origin/main b3623b8.
- eng-helper: bounded read-only field/display research, assigned/live response pending.
- eng-dev-sr: mandatory pre-plan checkpoint requested; advice pending. Completion checkpoint required later; same-error-twice checkpoint if triggered. Neither gate is satisfied merely by requesting advice.
- eng-reviewer: early acceptance/edge-case review requested; independent exact-head QA required after implementation.
- eng-dev-mid: intended routine implementation owner; not assigned coding until plan checkpoint resolves.

## Existing delivery state (verified GitHub)

- PRs #1, #3, #4 merged; #4 merge is remote main b3623b8.
- PR #5 corrective selection fix OPEN at 872d39c; independent 107 tests and 26 Chrome checks cleared; human merge approval pending from prior request, not resent.
- PR #2 wiki OPEN at e230d04; independent docs clearance recorded, human merge approval pending. Detailed historical decisions live on that branch; main wiki is older.
- PR #6 staffing docs OPEN at 2661953; current owner instructions supersede main wiki staffing. Do not duplicate its changes or merge it without approval.

## Proposed boundaries and next actions

Expose known per-session used/limit/remaining context consistently, labelled last reported; unknown fields stay unknown. Do not use cumulative billed tokens or sum child usage into parent context. Existing detail context bar and live text already exist; verify current provider semantics and gaps before final plan.

Next: collect helper/reviewer feedback and senior pre-plan advice; finalize acceptance/model/flows, assign mid in this thread, then PR + independent QA + senior completion checkpoint, then separate human merge gate. No default-branch writes/merges/deployments authorized.
