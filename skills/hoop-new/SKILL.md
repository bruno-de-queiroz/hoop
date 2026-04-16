---
name: hoop-new
description: Initialize a new Hoop P2P collaborative session and generate a unique session code
---

# Hoop New Session

## Arguments

The user may invoke this skill as `/hoop-new` or `/hoop-new <password>`. Extract the optional password from the args string — everything after the command name, trimmed. If no password is provided, proceed without one.

## Steps

1. **Prompt for execution target.** Ask the user to select how tool calls will be executed during the session. Present exactly this prompt:

   ```
   Select execution target:
     1. Host-Only — all execution on the host machine (default)
     2. Proponent-Side — execution on the requesting peer's machine

   Enter choice (1 or 2):
   ```

   If the user enters `2`, set `executionTarget` to `"proponent-side"`. For any other input (including empty/no response), default to `"host-only"`.

2. **Create the session.** Call the `hoop_create_session` MCP tool with the parsed password and selected execution target.

   Use these params:

   ```json
   {
     "password": "<password, omit if not provided>",
     "executionTarget": "<executionTarget>"
   }
   ```

   Do not import or execute TypeScript directly. The MCP server owns the session lifecycle, including admission handling. If the tool returns an error, display the error message and stop. On success, parse the tool response and use it as the source of truth for the session details. The response includes `sessionCode`, `peerId`, `listenAddresses`, `executionTarget`, `hostId`, `passwordProtected`, `branchName`, and `worktreePath`.

   Admission requests from peers are handled asynchronously via hooks. When a peer requests to join, the `UserPromptSubmit` hook surfaces pending admissions. You do not need to handle admission inline — the MCP server queues requests and the hook flow will prompt you to admit or deny.

3. **Display the session details.** Output the result prominently so the user can share with peers:

   ```
   Session created!

   Code: <result.sessionCode>
   Target: <result.executionTarget>
   Branch: <result.branchName>
   Worktree: <result.worktreePath>
   Peer ID: <result.peerId>
   Listen addresses:
     <each address from result.listenAddresses>

   Share this code with peers — they can join with:
     /hoop-join <result.sessionCode>

   Provide the listen address above so peers can connect.
   ```

   If `result.passwordProtected` is true, also note that a password is required to join.
   If `result.branchName` is undefined, note that git worktree creation was skipped (not a git repository).
