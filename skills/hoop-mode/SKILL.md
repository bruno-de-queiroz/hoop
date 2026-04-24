---
name: hoop-mode
description: Set the governance mode for the active Hoop session
---

# Hoop Mode

## Arguments

The user invokes this skill as `/hoop-mode <mode> [threshold]`. Parse the args string as follows:

1. The first token is the **mode**. It must be one of: `host-only`, `zero-trust`, `yolo`. If the token is not recognized, display an error and stop:

   ```
   Unknown mode: <token>. Must be one of: host-only, zero-trust, yolo
   ```

2. If the mode is `zero-trust`, an optional second token is the **threshold**:
   - `majority` — requires >50% of connected peers to approve
   - `consensus` — requires 100% of connected peers to approve
   - A positive integer (e.g. `3`) — requires exactly that many peer approvals

   If the second token is present but not recognized as `majority`, `consensus`, or a positive integer, display an error and stop:

   ```
   Invalid threshold: <token>. Must be one of: majority, consensus, or a positive integer
   ```

   If no threshold is provided for `zero-trust`, omit it from the tool call (the server will keep the current threshold).

3. If the mode is NOT `zero-trust` and a second token is present, display an error and stop:

   ```
   Threshold is only valid for zero-trust mode.
   ```

If no mode is provided, display a usage error and stop:

```
Usage: /hoop-mode <mode> [threshold]

  mode        Required. One of: host-only, zero-trust, yolo
  threshold   Optional. Only for zero-trust mode.
              One of: majority (>50%), consensus (100%), or a positive integer

Examples:
  /hoop-mode host-only
  /hoop-mode zero-trust majority
  /hoop-mode zero-trust consensus
  /hoop-mode zero-trust 3
  /hoop-mode yolo
```

## Steps

1. **Validate the session.** Call the `hoop_get_status` MCP tool. If the response shows `active: false`, display an error and stop:

   ```
   No active Hoop session. Start or join one first:
     /hoop-new    — create a new session
     /hoop-join   — join an existing session
   ```

   If the role is not `host`, display an error and stop:

   ```
   Only the host can change the governance mode.
   ```

2. **Set the mode.** Call the `hoop_set_mode` MCP tool with:
   - `mode`: the parsed mode
   - `threshold`: the parsed threshold (only include if mode is `zero-trust` and a threshold was provided)

   If the tool returns an error, display it and stop.

3. **Display the result.** On success, display:

   ```
   Governance mode set to: <mode>
   ```

   If the mode is `zero-trust`, also display:

   ```
   Approval threshold: <threshold>
   ```

   Where `<threshold>` is one of:
   - `majority (>50% of peers)`
   - `consensus (100% of peers)`
   - `<N> peer(s)` (for integer thresholds)

   If the response includes `unchanged: true`, display instead:

   ```
   Governance mode is already set to: <mode>
   ```
