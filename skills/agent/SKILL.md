---
name: agent
description: Spawn a sub-agent within an active Hoop session with an optional model override
---

# Hoop Agent

## Arguments

The user invokes this skill as `/hoop:agent [--model <name>] <prompt>`. Parse the args string as follows:

1. If the args string starts with `--model `, consume the next token as the model override. It must be one of the known model names: `opus`, `sonnet`, `haiku`. If the token after `--model` is not a recognized model name, display an error and stop:

   ```
   Unknown model: <token>. Must be one of: opus, sonnet, haiku
   ```

   Everything after the model token is the prompt.
2. Otherwise, there is no model override — the entire args string is the prompt.

This flag-based syntax avoids ambiguity when the prompt itself starts with a model name (e.g. `/hoop:agent haiku generator` is unambiguously a prompt, not a model override).

If the prompt is empty after parsing, display a usage error and stop:

```
Usage: /hoop:agent [--model <name>] <prompt>

  --model   Optional. One of: opus, sonnet, haiku
  prompt    Required. The task for the sub-agent to execute.

Examples:
  /hoop:agent Fix the auth bug in login.ts
  /hoop:agent --model sonnet Refactor the database module
```

## Steps

1. **Validate the session.** Call the `hoop_get_status` MCP tool. If the response shows `active: false`, display an error and stop:

   ```
   No active Hoop session. Start or join one first:
     /hoop:new    — create a new session
     /hoop:join   — join an existing session
   ```

   On success, extract the session details from the response. The available fields differ by role:

   - **Both roles**: `role`, `sessionCode`, `branchName`
   - **Host only**: `executionTarget`, `worktreePath`
   - **Peer only**: `localPeerId`, `hostPeerId`

   These will be passed as context to the sub-agent. Only include fields that are present in the response.

2. **Acquire the lock.** Call the `hoop_acquire_lock` MCP tool to claim the Hot Seat before the agent begins work. If the lock is not acquired (another peer holds it), display the conflict and stop:

   ```
   Cannot start agent — Hot Seat lock is held by another peer.
   Wait for the lock to be released or ask the holder to release it.
   ```

3. **Determine execution path.** Check if this prompt should execute locally or be delegated to the host:

   - **Execute locally** if ANY of these are true:
     - The role is `host` (the host always executes locally — it IS the host)
     - The `executionTarget` is `"proponent-side"`

   - **Delegate to host** if ALL of these are true:
     - The role is `peer`
     - The `executionTarget` is `"host-only"`

   Proceed to step 3A or 3B accordingly.

### Path A: Local execution (proponent-side or host)

3A. **Spawn the sub-agent.** Use the `Agent` tool with:

   - `description`: a short (3-5 word) summary derived from the user's prompt.
   - `model`: the parsed model override if one was provided; omit the parameter entirely if no model was specified (inherits the current session default).
   - `prompt`: compose the prompt by prefixing the user's prompt with the session context. Only include fields that were present in the `hoop_get_status` response:

     ```
     You are operating within an active Hoop collaborative session.

     Session: <sessionCode>
     Role: <role>
     Branch: <branchName>
     ```

     If the role is `host`, also include:
     ```
     Worktree: <worktreePath>
     Execution target: <executionTarget>
     ```

     If the role is `peer`, also include:
     ```
     Host peer: <hostPeerId>
     ```

     Then always append:
     ```
     The Hoop hook system is active — file edits are broadcast to peers automatically,
     and conflict checks run before writes. Do not call hoop MCP tools directly.

     Task:
     <user's prompt>
     ```

   Wait for the sub-agent to complete before proceeding to step 4.

### Path B: Host execution (peer in host-only session)

3B. **Send the prompt to the host.** Call the `hoop_request_host_execution` MCP tool with:
   - `prompt`: the user's prompt text
   - `model`: the parsed model override if one was provided; omit if not specified

   The tool returns a `requestId` and an initial `status` (`"pending-approval"` or `"approved"`).

   If the initial status is `"pending-approval"`, display:

   ```
   Prompt sent to host for approval. Waiting for the host to approve, reject, or discuss...
   ```

   If the initial status is `"approved"`, display:

   ```
   Prompt auto-approved by host. Execution starting...
   ```

   **Poll for completion.** Repeatedly call `hoop_poll_execution_result` with the `requestId`. Check the returned `status`:

   - `"pending-approval"` or `"approved"` — still waiting. Wait a few seconds and poll again.
   - `"executing"` — host is actively working. Continue polling.
   - `"completed"` — host finished successfully. Proceed to step 4.
   - `"failed"` — host execution failed. Note the error. Proceed to step 4.
   - `"denied"` — host rejected the prompt. Note the reason. Proceed to step 4.

   Poll at reasonable intervals (every 5-10 seconds). Do NOT poll more than 60 times (roughly 5 minutes). If the poll limit is reached, display a timeout warning and proceed to step 4.

4. **Release the lock.** Call the `hoop_release_lock` MCP tool. This step MUST execute regardless of whether the agent/host succeeded or failed — treat it as a finally block. If the release fails, warn the user but do not suppress the result.

5. **Display the result.**

   **For local execution (Path A):** Surface the sub-agent's output to the user. Prefix it with a brief status line:

   ```
   Agent completed. Lock released.
   ```

   If the sub-agent encountered an error, still display whatever output it produced, prefixed with:

   ```
   Agent encountered an error. Lock released.
   ```

   **For host execution (Path B):** Display the outcome:

   - If completed:
     ```
     Host execution completed. Lock released.
     File changes have been broadcast and applied.
     ```

   - If failed:
     ```
     Host execution failed: <error>. Lock released.
     ```

   - If denied:
     ```
     Host denied the prompt: <reason>. Lock released.
     ```

   - If timed out:
     ```
     Host execution timed out. Lock released.
     Check with the host for status.
     ```
