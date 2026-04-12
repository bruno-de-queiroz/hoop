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

4. **Join the session.** Call `joinSession()` from `src/session/joinSession.ts`:

   ```typescript
   import { joinSession } from "src/session/joinSession.js";

   const result = await joinSession({
     sessionCode,    // from args
     hostAddress,    // from step 2
     password,       // from args — undefined if not provided
     email,          // from step 3
   });
   ```

   This internally validates the session code, starts a P2P node, dials the host, sends an admission request with the email, and waits for the host to admit the peer. If the session code is invalid, the connection fails, or the host denies admission, it throws an error — display the error message and stop. If denied, the peer must wait 60 seconds before retrying.

5. **Display connection status.** On success, display:

   ```
   Connected to session!

   Session: <result.sessionCode>
   Host peer: <result.hostPeerId>
   Local peer: <result.localPeerId>

   You are now connected to the host's P2P node.
   ```

   If `result.passwordProvided` is true, also note:
   ```
   Password provided — awaiting handshake verification (managed by host).
   ```
