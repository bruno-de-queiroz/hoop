---
name: leave
description: Gracefully leave the active Hoop session — closes the libp2p node and clears state. Works for both host and peer.
---

# Hoop Leave Session

## Arguments

No arguments. Invoke as `/hoop:leave`.

## Steps

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

## Notes

- **This does NOT delete the worktree** — local commits on the session branch remain in `.hoop/sessions/<code>/`. Use git directly if you want to clean up.
- **This does NOT push pending commits** — anything not already pushed by auto-push (on lock release) stays local.
- **For force-releasing the Hot Seat mutex** (e.g. when a peer agent crashed mid-edit), use `/hoop:unlock` instead — that releases the lock without disconnecting the session.
