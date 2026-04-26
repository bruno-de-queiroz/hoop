---
name: settings
description: Update settings on the active Hoop session (host-only) — currently the governance mode and zero-trust threshold
---

# Hoop Settings

## Steps

1. **Update settings.** Call the `hoop_set_settings` MCP tool with **no arguments**. The MCP server drives the form (governance mode + zero-trust threshold if applicable) via elicitation — do not parse a numbered menu yourself, do not prompt the user for these values.

   **Critical:** Pass exactly `{}`. DO NOT pass `mode` or `threshold` — the server will elicit those values interactively. Filling them yourself bypasses the form.

   ```json
   {}
   ```

   If the tool returns an error (e.g. "Only the host can update session settings.", "No active host session.", or "Settings update cancelled"), display the error message and stop.

2. **Display the result.** On success, the response includes `accepted: true`, a `governance` object describing the applied config, and `executionTarget` (read-only — set at session creation, immutable mid-session). Display:

   ```
   Execution target: <executionTarget> (immutable — set at session creation)
   Governance mode set to: <governance.mode>
   ```

   When `governance.mode === "zero-trust"`, also display:

   ```
   Approval threshold: <governance.threshold>
   ```

   Where `<governance.threshold>` is one of:
   - `majority (>50% of peers)`
   - `consensus (100% of peers)`
   - `<N> peer(s)` (for integer thresholds)

   If the response includes `unchanged: true`, display instead:

   ```
   Governance settings already current: <governance.mode>
   ```

   If the response includes a `warning` field (party-size fallback), display it after the main result:

   ```
   Note: <warning>
   ```
