# Project status

Updated 2026-11-01 by eng-pm. Read before assignments; detailed history is in docs/wiki.md. Last verified remote main b3623b8; local main e2503cb is stale.

## CCC-CTX-01 — context status per agent/session

Goal: show last-reported context in session list, Details/live line and existing subagent rows, with explicit independent unknowns and no parent/child aggregation.

Current scope: Admin approved same-record-only Codex context in sw_594d8635e3a80f8126a6b34c6f85b5be, replying to decision sw_ddb10d2ee97644578f6e28ae3c34c5ff. Remove turn inference entirely; tokens/window come only from the same token_count. Codex context model is not reported. Claude uses native same-message evidence; accepted UI and compaction/replay guards remain.

Status: revised implementation authorized after senior pre-plan advice sw_88a5136516584e8bab5d927e83ed71bd. Mid resumes on existing PR #8, feat/context-status, last submitted69e4d41 (unreviewed). Old turn-inference implementation failed independent QA; no old clearance applies to the revised scope.

Owners and gates:
- eng-pm: scope, task state/wiki, PR #7 docs/context-status-plan; resolve blockers and human decisions.
- eng-dev-mid: bounded implementation, tests and PR; remove Codex turn caches/inference, keep Claude and independent child context; say which prior head is base. Report stable exact head before review.
- eng-reviewer: reviewer-first exact-head ingestion rechecks and synthetic browser/SSE including Codex model-not-reported; not assigned more old-head QA.
- eng-dev-sr: revised pre-plan advice received; completion checkpoint follows reviewer repro result. Any same error twice requires consultation before more patches.
- eng-helper: original read-only research complete, no active errand.

Verification: last independently tested9377a3f had148/148 and original four repros pass, but eviction/late-start/fallback misassociation failed.69e4d41 has150 developer tests only, preserved unreviewed. Presentation/browser/SSE passes atb42e1ca are historical, not revised-scope clearance. Earlier count discrepancy resolved:018fa5b=140,5742f8e=143.

Next: implement same-record-only rules and ingestion regressions; reviewer checks first, then senior completion advice; only after both clear request human merge approval. No merge/deploy/release authorized.

## Other project state (last verified, do not duplicate assignments)

PRs #1/#3/#4 merged; PR #5 corrective Copy fix OPEN at872d39c, independent107 tests/26 Chrome checks cleared, prior human merge decision pending. PR #2 wiki OPEN ate230d04 with docs clearance/prior merge decision pending. PR #6 staffing docs OPEN at2661953. No unanswered decision resent. Owner-approved current roster supersedes stale main wiki staffing.
