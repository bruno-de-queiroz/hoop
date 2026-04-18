---
name: hoop-agent
description: Spawn a sub-agent within an active Hoop session with an optional model override
---

# Hoop Agent

## Arguments

The user invokes this skill as `/hoop-agent [model] <prompt>`. Parse the args string as follows:

1. Split the args string into the first token and the rest.
2. If the first token exactly matches one of the known model names — `opus`, `sonnet`, `haiku` — treat it as the model override and the rest as the prompt.
3. Otherwise, there is no model override — the entire args string is the prompt.

If the prompt is empty after parsing, display a usage error and stop:

```
Usage: /hoop-agent [model] <prompt>

  model   Optional. One of: opus, sonnet, haiku
  prompt  Required. The task for the sub-agent to execute.

Examples:
  /hoop-agent Fix the auth bug in login.ts
  /hoop-agent sonnet Refactor the database module
```

## Steps

1. **Validate the session.** Call the `hoop_get_status` MCP tool. If the response shows `active: false`, display an error and stop:

   ```
   No active Hoop session. Start or join one first:
     /hoop-new    — create a new session
     /hoop-join   — join an existing session
   ```

   On success, extract the session details: `role`, `sessionCode`, `branchName`, `worktreePath`, and `executionTarget`. These will be passed as context to the sub-agent.

2. **Acquire the lock.** Call the `hoop_acquire_lock` MCP tool to claim the Hot Seat before the agent begins work. If the lock is not acquired (another peer holds it), display the conflict and stop:

   ```
   Cannot start agent — Hot Seat lock is held by another peer.
   Wait for the lock to be released or ask the holder to release it.
   ```

3. **Spawn the sub-agent.** Use the `Agent` tool with:

   - `model`: the parsed model override if one was provided; omit the parameter entirely if no model was specified (inherits the current session default).
   - `prompt`: compose the prompt by prefixing the user's prompt with the session context:

     ```
     You are operating within an active Hoop collaborative session.

     Session: <sessionCode>
     Role: <role>
     Branch: <branchName>
     Worktree: <worktreePath>
     Execution target: <executionTarget>

     The Hoop hook system is active — file edits are broadcast to peers automatically,
     and conflict checks run before writes. Do not call hoop MCP tools directly.

     Task:
     <user's prompt>
     ```

   Wait for the sub-agent to complete before proceeding.

4. **Release the lock.** Call the `hoop_release_lock` MCP tool. This step MUST execute regardless of whether the sub-agent succeeded or failed — treat it as a finally block. If the release fails, warn the user but do not suppress the agent's result.

5. **Display the result.** Surface the sub-agent's output to the user. Prefix it with a brief status line:

   ```
   Agent completed. Lock released.
   ```

   If the sub-agent encountered an error, still display whatever output it produced, prefixed with:

   ```
   Agent encountered an error. Lock released.
   ```
