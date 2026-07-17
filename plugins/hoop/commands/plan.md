---
description: Propose a plan for approval — the session goes hard read-only until you approve it
---

`/plan <task>` runs the current turn in **plan mode**. Unlike a normal turn, the
sandbox enforces this mechanically rather than by asking the model nicely:

- **Hard read-only.** While planning, the permission gate DENIES every mutating
  tool — Write, Edit, MultiEdit, NotebookEdit, Bash, subagents (Task), and MCP
  writes. Only read-only investigation (Read, Grep, Glob, ToolSearch, web
  search/fetch) is allowed. The agent physically cannot touch the repo.
- **Deterministic capture.** When the agent calls `ExitPlanMode` with its plan,
  the sandbox captures it and opens it for review — the tool is denied so the
  turn stops and holds.
- **Collaborative review.** The plan appears in the dashboard's plan panel. You
  and any co-driving peers can add inline comments/annotations, then approve or
  reject.
  - **Approve** → the session leaves read-only and runs a follow-up turn that
    implements the approved plan (normal permission gating resumes).
  - **Reject** (with feedback) → the session stays read-only and the agent
    revises the plan against your comments.

The brief injected for a plan turn lives in `prompts/plan.md` in this plugin and
can be edited without rebuilding the sandbox. Enforcement lives in the sandbox
permission policy + the PreToolUse gate (`hooks/scripts/permission-gate.sh`), so
it holds regardless of whether the model "cooperates."

Usage: `/plan add rate limiting to the login endpoint`
