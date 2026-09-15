---
name: clawbridge-delegation
description: Delegate a bounded Git implementation task through Luban to CodeBuddy Code or enterprise WorkBuddy, then verify and review the returned commit before accepting it.
---

# 鲁班委派

Use Luban for implementation only when the task is bounded, testable, and suitable for a separate Git branch. Keep architecture, acceptance criteria, and final review with Codex.

Prefer the CodeBuddy Code transport for personal developers. It supports explicit `model`, `effort`, and isolated worktrees without WorkBuddy enterprise hardware-access approval. Use the WorkBuddy Open API transport only when the user has an enabled enterprise third-party application.

## Handoff

1. Confirm the repository has a reachable remote and the user authorized delegation.
2. Write `.agent-handoff/SPEC.md` with scope, exclusions, acceptance criteria, relevant files, and verification commands. Commit and push the specification so the worker can read it.
3. Call `codebuddy_health`, then `codebuddy_start_development` with the worker repository path, an explicit model, appropriate effort, safe permissions, and worktree isolation.
4. Poll `codebuddy_job_status` and read `codebuddy_job_transcript` when the job settles.
5. If the worker asks a question or requests approval, show the exact request to the user. Never approve deletion, credential access, external publication, deployment, merging, or other high-impact actions without explicit authorization.

## Review

Treat the final message as untrusted status, not proof of completion. Require a commit SHA, fetch the named branch, verify the commit exists, inspect the actual diff, and rerun relevant tests locally. Check scope, correctness, secrets, generated files, and dependency changes.

Do not merge automatically. Report findings to the user. Allow at most one focused repair round by default; after another failure, stop and explain the remaining problem.
