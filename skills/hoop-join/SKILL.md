---
name: hoop-join
description: Join an existing Hoop P2P collaborative session by session code
---

# Hoop Join Session

## Arguments

The user may invoke this skill as `/hoop-join <sessionCode>` or `/hoop-join <sessionCode> <password>`. Parse the session code (first argument, required) and optional password (second argument) from the args string. The user's email will be prompted for during the join flow.

## Steps

1. **Parse the session code.** Extract the session code from the first argument. If no session code is provided, display an error and stop:

   ```
   Usage: /hoop-join <sessionCode> [password]
   ```

2. **Prompt for the host's listen address.** Ask the user to provide the host's multiaddr (listen address). The host displays this when creating a session. Present exactly this prompt:

   ```
   Enter the host's listen address (multiaddr):
   ```

   The address should look like `/ip4/x.x.x.x/tcp/PORT/p2p/PEERID`. If the user provides an empty or clearly invalid address, ask again.

3. **Prompt for email.** Ask the user for their email address so the host can identify them during the admission process:

   ```
   Enter your email (for host admission):
   ```

4. **Join the session.** Call the `hoop_join_session` MCP tool with the parsed session code, provided host address, optional password, and prompted email.

   Use these params:

   ```json
   {
     "sessionCode": "<sessionCode>",
     "hostAddress": "<hostAddress>",
     "password": "<password, omit if not provided>",
     "email": "<email>"
   }
   ```

   Do not import or execute TypeScript directly. The MCP server owns the join lifecycle. If the tool returns an error, display the error message and stop. On success, parse the tool response and use it as the source of truth for the connection details. The response includes `sessionCode`, `hostPeerId`, `localPeerId`, `authenticated`, `admitted`, and `branchName`.

5. **Display connection status.** On success, display:

   ```
   Connected to session!

   Session: <result.sessionCode>
   Host peer: <result.hostPeerId>
   Local peer: <result.localPeerId>

   You are now connected to the host's P2P node.
   ```

   If a password was provided and `result.authenticated` is true, also note:
   ```
   Password provided — authenticated with host.
   ```
