---
name: hoop-new
description: Initialize a new Hoop P2P collaborative session and generate a unique session code
---

# Hoop New Session

## Arguments

The user may invoke this skill as `/hoop-new` or `/hoop-new <password>`. Extract the optional password from the args string — everything after the command name, trimmed. If no password is provided, proceed without one.

## Steps

1. **Generate a session code.** Call `generateSessionCode()` from `src/session/sessionCode.ts`. It returns a unique code in `XXX-XXX` format using a URL-safe charset.

2. **Hash the password (if provided).** If the user supplied a password, use the `bcrypt` npm package to hash it with a salt round of 12. Store the result as `passwordHash`. If no password was given, omit `passwordHash`.

3. **Determine the host ID.** Use Node's `os.hostname()` as the `hostId`. If that is unavailable, generate a short random ID (e.g., 8 hex chars via `crypto.randomBytes(4).toString('hex')`).

4. **Build the Session object.** Construct a `Session` (from `src/session/session.ts`) with:
   - `sessionCode` — the generated code
   - `passwordHash` — the bcrypt hash, only if a password was provided
   - `hostId` — the hostname or generated ID
   - `createdAt` — `new Date()`

5. **Store the session.** Call `SessionStore.create(session)` to register it in the in-memory store.

6. **Display the session code.** Output the session code prominently so the user can share it with peers. Use a format like:

   ```
   Session created!

   Code: ABC-XYZ

   Share this code with peers — they can join with /hoop-join ABC-XYZ
   ```
   If the session is password-protected, also note that a password is required to join.
