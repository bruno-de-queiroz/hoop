---
name: leave
description: Gracefully leave the active Hoop session — closes the libp2p node and clears state. Works for both host and peer.
---

# Hoop Leave Session

> **Note for the model:** `/hoop:leave` is normally **routed by the harness, not by you**. The `UserPromptSubmit` hook intercepts the slash command, sends `SIGUSR2` to the MCP server (which calls `leaveSession()` internally), and blocks the prompt from reaching you with a confirmation message to the user. You should not see `/hoop:leave` as a user message under normal operation.
>
> This skill markdown is a fallback: if for any reason the hook didn't fire and the prompt did reach you, follow the steps below to achieve the same outcome by calling the MCP tool directly.

## Steps (fallback only)

1. **Validate the session.** Call the `hoop_get_status` MCP tool. If the response shows `active: false`, display:

   ```
   No active Hoop session — nothing to leave.
   ```

   Stop here.

2. **Leave the session.** Call the `hoop_leave_session` MCP tool with no arguments. The MCP server handles the role-specific shutdown internally:

   - **Host**: denies all pending admissions, clears the prompt request queue, closes the broadcast hub, stops the libp2p node, deletes the status file.
   - **Peer**: stops the ack interval, stops the libp2p node, clears local state, deletes the status file.

   The response includes `left: true`, `previousRole`, and `sessionCode`.

3. **Display the result.** On success, display:

   ```
   Left Hoop session <previousRole>: <sessionCode>
   ```

   The libp2p node is closed and you are no longer connected to peers.

## Why hook-routed?

Slash commands that *trigger an action* (vs. gather input) are routed by the harness so the action is hardware-guaranteed regardless of the model's behavior. A scripted/distracted/throttled model can mis-call or skip an MCP tool; a hook + signal cannot. This is the symmetric outbound rule to the elicit-input pattern: **harness owns critical actions, server elicits critical input.**

## Notes

- **This does NOT delete the worktree** — local commits on the session branch remain in `.hoop/sessions/<code>/`. Use git directly if you want to clean up.
- **This does NOT push pending commits** — anything not already pushed by auto-push (on lock release) stays local.
- **For force-releasing the Hot Seat mutex** (e.g. when a peer agent crashed mid-edit), use `/hoop:unlock` instead — that releases the lock without disconnecting the session.
