---
name: unlock
description: Force-release the Hot Seat mutex lock when a peer agent hangs or crashes (host only)
---

# Hoop Force Unlock

## Arguments

No arguments. Invoke as `/hoop:unlock`.

## Steps

1. **Check lock status.** Call the `hoop_lock_status` MCP tool to see the current lock state.

   If the lock is already free (`status: "free"`), inform the user:

   ```
   Lock is already free — no action needed.
   ```

   Stop here.

2. **Confirm with the user.** Display the current lock holder and ask for confirmation:

   ```
   The Hot Seat lock is currently held by: <holderPeerId>
   Acquired at: <acquiredAt as human-readable time>

   Force-releasing will immediately free the lock, which may cause
   the holding peer's in-progress work to lose write access.

   Proceed? (y/n):
   ```

   If the user declines, stop without taking action.

3. **Force-release the lock.** Call the `hoop_force_unlock` MCP tool.

   If the tool returns `released: true`, display:

   ```
   Lock force-released successfully. The Hot Seat is now free.
   ```

   If the tool returns `released: false`, display:

   ```
   Lock was already released (possibly by TTL expiry or peer disconnect).
   ```

   If the tool returns an error, display the error message.
