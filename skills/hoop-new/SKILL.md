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

2. **Create the session.** Call `createSession()` from `src/session/createSession.ts`, providing an `onAdmissionRequest` callback that presents a dialog to the host user whenever a new peer requests to join:

   ```typescript
   import { createSession } from "src/session/createSession.js";

   const result = await createSession({
     password,            // from args — undefined if not provided
     executionTarget,     // from step 1
     onAdmissionRequest: async (email, peerId) => {
       // Present admission dialog to the host user
       // Show: "Peer <email> (ID: <peerId>) wants to join. Admit? (yes/no)"
       // Return true to admit, false to deny (denied peers must wait 60s to retry)
     },
   });
   ```

   The `onAdmissionRequest` callback fires each time a new peer requests admission. Present the peer's email to the host user and ask them to admit or deny. If denied, the peer is disconnected and cannot retry for 60 seconds.

   This internally generates a session code, hashes the password (if provided), starts a P2P node, registers the session, and creates a git worktree for the session. The returned `result` contains `sessionCode`, `peerId`, `listenAddresses`, `executionTarget`, `hostId`, `passwordProtected`, `branchName`, and `worktreePath`.

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
