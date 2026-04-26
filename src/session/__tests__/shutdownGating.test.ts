import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { createSession, defaultAdmissionHandler, stubGitOps, type CreateSessionResult, type GitOps } from "../createSession.js";
import { SessionStore } from "../session.js";

describe("shutdown gating: auto-push during session shutdown", () => {
  let session: CreateSessionResult;
  let store: SessionStore;
  let spyAddAndCommit: MockInstance<GitOps["addAndCommit"]>;
  let spyPushBranch: MockInstance<GitOps["pushBranch"]>;

  beforeEach(async () => {
    store = new SessionStore();
    const gitOps = { ...stubGitOps };
    spyAddAndCommit = vi.spyOn(gitOps, "addAndCommit");
    spyPushBranch = vi.spyOn(gitOps, "pushBranch");

    session = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );
  });

  it("gates auto-push after markShuttingDown is called", async () => {
    // Acquire and release the lock (triggers auto-push normally)
    session.acquireLock();
    session.releaseLock();

    // Wait a tick for the auto-push chain to start
    await new Promise((r) => setImmediate(r));
    const pushCountBefore = spyPushBranch.mock.calls.length;

    // Now mark shutdown and trigger a peer disconnect (which would release any lock)
    session.markShuttingDown();

    // Force-release to trigger a lock-release update (which would normally auto-push)
    session.forceReleaseLock();

    // Wait a bit to ensure no auto-push fires
    await new Promise((r) => setTimeout(r, 50));

    // Verify: no new push calls should have happened after shutdown was marked
    const pushCountAfter = spyPushBranch.mock.calls.length;
    expect(pushCountAfter).toBe(pushCountBefore);
  });

  it("markShuttingDown is idempotent", () => {
    // Call multiple times
    session.markShuttingDown();
    session.markShuttingDown();
    session.markShuttingDown();

    // Should not throw and should be safe
    expect(() => {
      session.markShuttingDown();
    }).not.toThrow();
  });

  it("auto-push fires normally before markShuttingDown is called", async () => {
    // Acquire and release the lock before shutdown
    session.acquireLock();
    const lockResult = session.releaseLock();
    expect(lockResult.released).toBe(true);

    // Drain to ensure the push completes
    await session.drainPendingPush();

    // Verify: at least one push happened (might be 1 or more due to init + lock ops)
    expect(spyPushBranch.mock.calls.length).toBeGreaterThan(0);
    // Verify: at least one commit happened in response to lock release
    expect(spyAddAndCommit.mock.calls.length).toBeGreaterThan(0);
  });

  it("broadcast of lock-release still happens during shutdown (only auto-push is gated)", async () => {
    // First acquire a lock so we can release it after shutdown
    session.acquireLock();

    session.markShuttingDown();

    let updateCount = 0;
    const offUpdate = session.onPublishedUpdate(() => {
      updateCount++;
    });

    // Clear prior push calls from setup/acquire
    spyPushBranch.mockClear();

    // Release the lock: should broadcast but not auto-push
    const result = session.releaseLock();
    expect(result.released).toBe(true);

    await new Promise((r) => setImmediate(r));

    // Verify: the lock-release was still published (broadcast fired)
    expect(updateCount).toBeGreaterThan(0);
    // Verify: no push was triggered (auto-push was gated)
    expect(spyPushBranch.mock.calls.length).toBe(0);

    offUpdate();
  });

  it("lock acquire/release still works after markShuttingDown", () => {
    session.markShuttingDown();

    const acquireResult = session.acquireLock();
    expect(acquireResult.acquired).toBe(true);

    const releaseResult = session.releaseLock();
    expect(releaseResult.released).toBe(true);
  });
});
