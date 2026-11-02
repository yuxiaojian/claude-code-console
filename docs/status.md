# Project status

Updated 2026-11-01 by eng-pm. Read before assignment; wiki contains detailed history. Actual remote main: b3623b8. Local main checkout remains e2503cb; do not implement from that stale checkout.

## Goal and current task

CCC-CTX-01: show context-window status per agent/session (Admin request sw_92042f9d3d52770463d7ea2a6ee2a549). Task thread is that message in claude-code-console-local. Plan finalized after senior advice sw_18dd90a5b1bd486f835063d5ed17748f; implementation ready-for-review in PR #8 at a667635e12d6c1310eb07bd045fc0e02c020e510, branch feat/context-status, based b3623b8. Fix head submitted for recheck: developer claims all interim context-accuracy blockers resolved with six ingestion regressions, 131 tests passing. Independent original-repro rechecks/browser-SSE and senior completion remain pending; not cleared.

- eng-pm: requirements, plan, wiki/status; branch docs/context-status-plan in claude-code-console-context-plan, based on origin/main b3623b8.
- eng-helper: read-only research complete (sw_dab1560aa5114594a5ff6a9d4db90cac).
- eng-dev-sr: mandatory pre-plan checkpoint passed with updated advice sw_18dd90a5b1bd486f835063d5ed17748f. Completion checkpoint requested for PR #8; response pending; same-error-twice checkpoint if triggered. Neither gate is satisfied merely by requesting advice.
- eng-reviewer: early acceptance feedback received (sw_d834986f84c14ab486222bdb650cd163); independent exact-head review/browser-SSE QA requested at PR #8 head 15dff13b.
- eng-dev-mid: implementation owner; isolated branch/worktree, tests and PR per finalized plan below.

## Existing delivery state (verified GitHub)

- PRs #1, #3, #4 merged; #4 merge is remote main b3623b8.
- PR #5 corrective selection fix OPEN at 872d39c; independent 107 tests and 26 Chrome checks cleared; human merge approval pending from prior request, not resent.
- PR #2 wiki OPEN at e230d04; independent docs clearance recorded, human merge approval pending. Detailed historical decisions live on that branch; main wiki is older.
- PR #6 staffing docs OPEN at 2661953; current owner instructions supersede main wiki staffing. Do not duplicate its changes or merge it without approval.

## Proposed boundaries and next actions

Expose known per-session used/limit/remaining context consistently, labelled last reported; unknown fields stay unknown. Do not use cumulative billed tokens or sum child usage into parent context. Existing detail context bar and live text already exist; verify current provider semantics and gaps before final plan.

Reviewer independently confirms 125/125 tests pass at 15dff13, but controlled store repros expose accuracy blockers; browser/SSE evidence not yet produced. Next: reviewer exact-head review/browser-SSE checks and senior completion response; route fixes to mid and recheck before human merge gate. No default-branch writes/merges/deployments authorized.
