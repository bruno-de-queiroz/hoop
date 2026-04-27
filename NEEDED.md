# NEEDED — deferred work

Items that surfaced during reviews and manual testing but were intentionally
not fixed in the same pass either because they require architectural design
discussion, are pre-MVP scope, or cannot be safely automated by an
implementer agent without product input.

Each entry: what, why-it's-deferred, what-the-fix-looks-like.

> **Note**: items in this file are *deferred*, not abandoned. Mechanical
> fixes that surfaced during the same review have already been shipped
> across commits `10d1764` → `HEAD` (governance rename + elicit-driven
> settings, path traversal, prompt injection, network DoS, atomicity,
> race fixes, lock-acquire-after-disconnect protection, and more).

---

## Hook-routed direct-action skills (e.g. `/hoop:leave`)

**Problem:** Skills like `/hoop:leave` go through the model. The model decides
whether to call the underlying MCP tool. A scripted/distracted/throttled
model can miss the call, leaving the user with broken UX. We hit this during
manual testing of the mock-llm peer scenario: `/hoop:leave` returned the
last cached `hoop_join_session` text instead of actually leaving.

**Why deferred:** Adds a new IPC channel (signal or socket) between hooks
and the MCP server; needs design for the dispatch table and signal
semantics. Touches `hooks/`, `src/mcp/server.ts`, and the skill markdowns.
Half-day of work + design call.

**Shape of the fix:**
1. `UserPromptSubmit` hook intercepts `/hoop:leave` (regex match) before it
   reaches the model. Block the prompt; print confirmation to the user.
2. Hook reads MCP server PID from a state file written at startup.
3. Hook sends `SIGUSR2` (or pipes a JSON command via a Unix socket) to the
   MCP process.
4. MCP server installs a `SIGUSR2` handler mapped to `gracefulShutdown`,
   resets state, stays alive (distinct from `SIGUSR1` in `session-end.sh`
   which tears the whole process down).
5. `skills/leave/SKILL.md` becomes documentation only — not in the model
   skill list.

Generalizes to any "command" action with no UX (e.g. `/hoop:unlock`,
`/hoop:settings` when args supplied). Does NOT replace the elicit pattern
— that's for *gathering input*; this is for *executing actions*.

Related rule already in memory: "Always use MCP elicit for human input"
(`feedback_use_elicit_for_input.md`). This is the symmetric outbound rule
— "harness owns critical actions."

---

## Email authentication for peer admission

**Problem:** `AdmissionRequest = { email: string }` (`network/protocol.ts`).
The host operator sees the email in the elicit prompt and approves on the
basis of a string the peer supplied with no proof of ownership. A
malicious peer types `bruno@commercetools.com`, the host operator
approves, attacker is in.

**Mitigation already in place:** Admit elicit message labels email as
"peer-supplied, NOT verified" and emphasises peerId as cryptographic.

**Why deferred:** Real fix requires a cryptographic binding of email →
peerId. Three plausible architectures, all out of MVP scope:

1. **Out-of-band trust list.** Host pre-shares an email→peerId map.
   Operator-managed. Fragile but simplest. Needs a manage-allowlist UX.
2. **Email-domain SSO.** Peer signs an OIDC/SAML token from a trusted IdP
   for their email domain. Host verifies the signature. Heavy infra lift.
3. **Signed assertion from a trusted third party.** Peer carries a
   signed certificate binding their email to their peerId, issued by a
   shared CA. Needs a certificate authority operations story.

For MVP, the host operator MUST trust the peerId, not the email. Document
this as a known limitation in user-facing docs.

---

## Denial cooldown bypass via libp2p peerId rotation

**Problem:** `deniedPeers` in `createSession.ts` is keyed by libp2p
peerId. An attacker spins up a fresh keypair (free, instant) and gets a
new admission slot.

**Mitigation already in place:** Global admission rate limit (20
requests/60s, prune-then-check-then-push) bounds the operator
prompt-bombing surface.

**Why deferred:** Per-IP rate limiting is the right next step but
extracting the source IP from a libp2p `Connection` requires parsing the
multiaddr (`/ip4/X/tcp/Y` etc.) and special-casing relayed connections
where the multiaddr's IP is the relay, not the origin. Needs a small
utility + tests.

**Shape of the fix:**
1. Helper `extractRemoteIp(connection: Connection): string | null` that
   reads `connection.remoteAddr` and pulls the IP component, returning
   null for circuit-relayed connections.
2. Replace `deniedPeers: Map<peerId, ts>` with `deniedSources: Map<ip, ts[]>`
   sliding window.
3. Document that relay-mode peers can rotate freely; either don't relay,
   or trust the relay to enforce its own rate limit.

---

## `/hoop:agent` lock leak (skills/agent/SKILL.md)

**Problem:** Skill instructs the model to "Step 2: acquire lock", "Step 3:
spawn sub-agent", "Step 4: release lock — MUST execute regardless." If
the LLM is interrupted between steps 2 and 4 (token limit, user `/clear`,
sub-agent crash), the lock is held until TTL (5 min). Lock acquisition
in markdown-the-LLM-may-skip is fragile.

**Why deferred:** Architectural — the right fix is "lock acquisition
belongs server-side around the actual execution span," not in skill
markdown. Needs design for how the MCP server knows when the sub-agent
has finished. Not haiku-fixable.

**Shape of the fix:**
1. New MCP tool `hoop_run_with_lock(args)` that acquires lock, runs the
   action, releases lock — atomic from the server's perspective. The
   skill becomes a thin caller of this tool.
2. The "action" payload is the agent invocation. MCP server uses
   server-side mechanisms (subprocess? sandboxed worker?) instead of
   relying on the LLM to call back.
3. TTL stays as a safety net, but the happy path is structured.

---

## State writer flock & pid-tagged registry paths

**Problem (separately tracked because they're code-fixable but I want them
in one place):** Several state writers do non-atomic `writeFileSync` and
share default paths across sessions. These are being addressed in the
Tier-A batch — listed here only because the design choice between
"single-machine multi-session" vs "single-session-per-machine" hasn't
been made.

**Open question:** Do we ever expect two `claude` processes on the same
host to be in two different hoop sessions simultaneously? If yes, the
default registry path needs a session/PID suffix (or move to `XDG_RUNTIME_DIR`
+ session subdir). If no, document the limitation and keep the simple
shared `tmpdir()` path.

Discuss before merging the Tier-A writer fix.
