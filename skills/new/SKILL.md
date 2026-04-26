---
name: new
description: Initialize a new Hoop P2P collaborative session and generate a unique session code
---

# Hoop New Session

## Arguments

The user may invoke this skill as `/hoop:new` or `/hoop:new <password>`. Extract the optional password from the args string — everything after the command name, trimmed. If no password is provided, proceed without one.

## Steps

1. **Create the session.** Call the `hoop_create_session` MCP tool. The MCP server itself drives the configuration form (execution target + governance mode + zero-trust threshold if applicable) via elicitation — do not prompt the user for these values yourself.

   **Critical:** Pass ONLY the `password` field (or `{}` if no password was provided). DO NOT pass `executionTarget`, `governanceMode`, `threshold`, or `autoExecutePrompts` — the server will elicit those values interactively from the user via a form. Filling those args yourself bypasses the form and silently uses defaults, which is wrong.

   Use exactly these params:

   ```json
   { "password": "<password>" }
   ```

   …or if no password was provided, call argless:

   ```json
   {}
   ```

   Do not import or execute TypeScript directly. The MCP server owns the session lifecycle, including settings elicitation and admission handling. If the tool returns an error, display the error message and stop. On success, parse the tool response and use it as the source of truth for the session details. The response includes `sessionCode`, `peerId`, `listenAddresses`, `executionTarget`, `governance`, `hostId`, `passwordProtected`, `branchName`, and `worktreePath`.

   Admission requests from peers are handled asynchronously via hooks. When a peer requests to join, the `UserPromptSubmit` hook surfaces pending admissions. You do not need to handle admission inline — the MCP server queues requests and the hook flow will prompt you to admit or deny.

2. **Display the session details.** Output the result prominently so the user can share with peers:

   ```
   Session created!

   Code: <result.sessionCode>
   Execution target: <result.executionTarget>
   Governance mode: <result.governance.mode>
   Approval threshold: <threshold>
   Branch: <result.branchName>
   Worktree: <result.worktreePath>
   Peer ID: <result.peerId>
   Listen addresses:
     <each address from result.listenAddresses>

   Share this code with peers — they can join with:
     /hoop:join <result.sessionCode>

   Provide the listen address above so peers can connect.
   ```

   Show the `Approval threshold` line ONLY when `result.governance.mode === "zero-trust"`. Render `<threshold>` using the same format as `/hoop:settings`:
   - `majority (>50% of peers)` when `result.governance.threshold === "majority"`
   - `consensus (100% of peers)` when `result.governance.threshold === "consensus"`
   - `<N> peer(s)` when `result.governance.threshold` is a positive integer

   If `result.passwordProtected` is true, also note that a password is required to join.
   If `result.branchName` is undefined, note that git worktree creation was skipped (not a git repository).
