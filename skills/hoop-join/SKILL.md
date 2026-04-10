---
name: hoop-join
description: Join an existing Hoop P2P collaborative session by session code
---

# Hoop Join Session

## Arguments

The user may invoke this skill as `/hoop-join <sessionCode>` or `/hoop-join <sessionCode> <password>`. Parse the session code (first argument, required) and optional password (second argument) from the args string.

## Steps

1. **Parse and validate the session code.** Extract the session code from the first argument. Use `validateSessionCode()` from `src/session/sessionCode.ts` to verify it matches the `XXX-XXX` format. If invalid, display an error and stop:

   ```
   Invalid session code format. Expected XXX-XXX (e.g., ABC-XYZ).
   ```

2. **Prompt for the host's listen address.** Ask the user to provide the host's multiaddr (listen address). The host displays this when creating a session. Present exactly this prompt:

   ```
   Enter the host's listen address (multiaddr):
   ```

   The address should look like `/ip4/x.x.x.x/tcp/PORT/p2p/PEERID`. If the user provides an empty or clearly invalid address, ask again.

3. **Create and start a P2P node.** Create a `HoopNode` from `src/network/node.ts` with a `NetworkConfig` (from `src/network/types.ts`) using transport mode `"local"`. Start the node with `await hoopNode.start()`.

4. **Connect to the host.** Call `await hoopNode.dial(hostAddress)` where `hostAddress` is the multiaddr provided by the user. This initiates the libp2p connection to the host's P2P node.

5. **Verify the connection.** After dialing, call `hoopNode.getConnectedPeers()` to confirm the connection was established. If no peers are connected, display an error:

   ```
   Failed to connect to host. Check the address and try again.
   ```

6. **Display connection status.** On successful connection, display:

   ```
   Connected to session!

   Session: ABC-XYZ
   Host peer: 12D3KooW...
   Local peer: 12D3KooW...

   You are now connected to the host's P2P node.
   ```

   If a password was provided, also note:
   ```
   Password provided — awaiting handshake verification (managed by host).
   ```
