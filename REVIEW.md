# REVIEW

Claude left behind a cheerful-looking pile of footguns.

The codebase has decent test coverage for happy paths, but several core collaboration flows are either incomplete, misleading, or flat-out wrong once you stop pretending the network, git state, and peers all behave perfectly.

## Overall verdict

**Not production-ready.**

The main problems are not style issues. They are correctness issues in the core promises of the project:

- session branch sharing is not wired for real-world use,
- diff generation lies about what it is diffing,
- patch verification is incomplete,
- handshake failures are treated as optional features,
- peer disconnect cleanup is inconsistent.

## Findings

### 1. Branch sync is conceptually broken for real peers
**Severity:** High  
**Files:** `src/session/createSession.ts`, `src/session/joinSession.ts`, `src/git/gitBranch.ts`

The host creates a **local worktree branch**:

- `createSession()` creates `hoop/session-${sessionCode}` with `git worktree add -b ...`
- `joinSession()` then tries to `fetchBranch(syncResponse.branchName)` and `checkoutBranch(syncResponse.branchName)`
- `fetchBranch()` defaults to `git fetch origin <branch>`

That only works if the branch already exists on `origin`, which this code never ensures.

So the “session branch sharing” story is basically fantasy outside stubs/tests. The host creates a local branch; the peer tries to fetch a remote branch that probably does not exist.

### 2. `computeFileDiff()` ignores the content it is given
**Severity:** High  
**Files:** `src/diff/computeDiff.ts`, `src/session/joinSession.ts`

`computeFileDiff(worktreePath, filePath, oldContent, newContent)` calculates hashes from `oldContent` and `newContent`, but the actual patch comes from:

- `git diff --no-color -- <file>`

That means the patch is generated from the current working tree state, not from the function arguments.

So the API claims to diff arbitrary content, but in reality it diffs whatever happens to be on disk. If the caller passes unsaved buffer contents, or if disk state diverges from the passed strings, the hashes and patch can describe different realities.

That is not a tiny bug. That is the whole contract being fake.

### 3. `applyFilePatch()` never verifies `expectedResultHash`
**Severity:** High  
**Files:** `src/diff/applyDiff.ts`

The return type advertises this error case:

- `result-hash-mismatch`

But the implementation never reads the patched file contents and never compares the resulting hash against `expectedResultHash`.

So the function only checks:

1. current content matches `expectedBaseHash`
2. `git apply --check` succeeds
3. `git apply` succeeds

It **does not** verify that the final content matches the claimed result hash. The API says one thing; the implementation does less.

### 4. Auth/admission errors are swallowed and treated as “protocol not supported”
**Severity:** High  
**Files:** `src/session/joinSession.ts`

In both the password and admission blocks, broad `catch` clauses collapse real failures into this comment-driven behavior:

- “Protocol not supported — host doesn't require ... proceed”

So transport errors, malformed responses, host bugs, or timing failures can all be mistaken for “this feature is optional.”

The result is a misleading join flow where the caller can continue after a broken auth/admission attempt and only discover later that sync behavior is crippled or empty.

That is sloppy error handling in a security-sensitive path.

### 5. Peer disconnect cleanup does not clear active edit conflicts
**Severity:** Medium  
**Files:** `src/session/createSession.ts`, `src/state/activeEditsTracker.ts`, `src/mcp/server.ts`

`ActiveEditsTracker` has `removePeer(peerId)`, but the disconnect path only calls:

- `accumulator.removePeer(peerId)`
- `broadcastHub.unsubscribe(peerId)`

I found no path that clears a disconnected peer from `ActiveEditsTracker`.

So a peer can disconnect and still leave behind stale conflict state:

- dirty-buffer conflicts can stick around indefinitely,
- file-change conflicts stick around until TTL expiry.

That means the hooks can keep warning or blocking edits based on a peer that is already gone.

### 6. Host-side update publication is duplicated and brittle
**Severity:** Medium  
**Files:** `src/session/createSession.ts`, `src/mcp/server.ts`

The host has a sensible internal path with `publishUpdate()` / `broadcastAppliedUpdate()`, but the MCP layer then bypasses that logic in multiple places and manually performs combinations of:

- `origAccumulate!(update)`
- `broadcastHub.broadcast(update)`
- `replayBuffer.push({ seqNo, update })`

This works only as long as every caller remembers all side effects in the right order. That is fragile and absolutely the kind of thing that drifts into inconsistencies later.

The monkey-patching of `accumulator.accumulate` inside `mcp/server.ts` makes this even uglier.

### 7. Tests are helping hide the wrong things
**Severity:** Medium  
**Files:** assorted tests under `src/**/__tests__`

The test suite is large, but several important behaviors are only “tested” against stubs or idealized flows:

- branch sharing is validated against stub git ops, not a real host-to-peer branch publication path,
- `applyFilePatch()` tests never verify result hash behavior because the implementation does not do it,
- diff generation tests mostly validate broadcast plumbing, not whether the patch corresponds to the passed content.

So the coverage number probably looks comforting while the real workflow still has holes you could drive a truck through.

## Recommended fixes

1. **Redesign branch handoff**
   - either push session branches to an agreed remote,
   - or stop pretending `fetch origin <branch>` is enough,
   - or send patches/state without requiring a remote branch fetch at all.

2. **Make diff generation honest**
   - generate the patch from the provided content,
   - or change the API so it explicitly says it diffs on-disk worktree state.

3. **Actually verify result hashes after patch application**
   - otherwise remove `result-hash-mismatch` from the contract and stop lying.

4. **Stop swallowing handshake failures**
   - distinguish “protocol not supported” from “request failed” from “invalid response”.

5. **Clear peer-local tracking on disconnect**
   - `ActiveEditsTracker.removePeer(peerId)` should be part of disconnect cleanup.

6. **Unify update publication in one code path**
   - one function should own accumulate + broadcast + replay bookkeeping.

## Final note

There is useful structure here, but too much of it is held together by optimistic assumptions, broad catches, and tests that congratulate the implementation for surviving its own mocks.

In other words: very Claude.
