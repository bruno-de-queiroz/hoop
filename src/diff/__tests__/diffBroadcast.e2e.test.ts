import { describe, it, expect, afterEach } from "vitest";
import {
  createSession,
  stubGitOps,
  defaultAdmissionHandler,
  type CreateSessionResult,
} from "../../session/createSession.js";
import {
  joinSession,
  stubJoinGitOps,
  type JoinSessionResult,
} from "../../session/joinSession.js";
import { SessionStore } from "../../session/session.js";
import type { StateUpdate, FileChangeUpdate } from "../../state/stateUpdate.js";
import { hashContent } from "../../git/gitBranch.js";

const VALID_PATCH = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 42;
 const c = 3;`;

describe("Diff broadcast", () => {
  let hostResult: CreateSessionResult | undefined;
  let joinResult: JoinSessionResult | undefined;
  let joinResult2: JoinSessionResult | undefined;

  afterEach(async () => {
    await Promise.all([
      hostResult?.node?.stop(),
      joinResult?.node?.stop(),
      joinResult2?.node?.stop(),
    ]);
    hostResult = undefined;
    joinResult = undefined;
    joinResult2 = undefined;
  });

  it("host broadcasts file-change update to joiner", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    const received = new Promise<StateUpdate>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for broadcast")),
        5000,
      );
      joinResult!.onBroadcast((update) => {
        clearTimeout(timeout);
        resolve(update);
      });
    });

    const fileChange: FileChangeUpdate = {
      type: "file-change",
      peerId: hostResult.peerId,
      filePath: "src/index.ts",
      patch: VALID_PATCH,
      baseHash: hashContent("const a = 1;\nconst b = 2;\nconst c = 3;\n"),
      resultHash: hashContent("const a = 1;\nconst b = 42;\nconst c = 3;\n"),
      timestamp: Date.now(),
    };

    hostResult.broadcastHub.broadcast(fileChange);

    const update = await received;
    expect(update).toEqual(fileChange);
  }, 30_000);

  it("peer sends file-change via UPDATE_PROTOCOL, host rebroadcasts to other peers", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    joinResult2 = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const received = new Promise<StateUpdate>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for broadcast")),
        5000,
      );
      joinResult2!.onBroadcast((update) => {
        clearTimeout(timeout);
        resolve(update);
      });
    });

    const fileChange: FileChangeUpdate = {
      type: "file-change",
      peerId: joinResult.localPeerId,
      filePath: "src/app.ts",
      patch: VALID_PATCH,
      baseHash: hashContent("old content"),
      resultHash: hashContent("new content"),
      timestamp: Date.now(),
    };

    await joinResult.sendUpdate(fileChange);

    const update = await received;
    expect(update).toEqual(fileChange);
  }, 30_000);

  it("host rejects file-change with invalid patch (not a unified diff)", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    joinResult2 = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    let receivedUpdate = false;
    joinResult2!.onBroadcast(() => {
      receivedUpdate = true;
    });

    // Send a file-change with raw content instead of a proper diff
    const invalidFileChange: FileChangeUpdate = {
      type: "file-change",
      peerId: joinResult.localPeerId,
      filePath: "src/secret.ts",
      patch: "this is raw file content, not a diff",
      baseHash: hashContent("old"),
      resultHash: hashContent("new"),
      timestamp: Date.now(),
    };

    await joinResult.sendUpdate(invalidFileChange);

    // Wait briefly and verify it was NOT broadcast
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(receivedUpdate).toBe(false);
  }, 30_000);

  it("multiple sequential file-change updates are delivered in order", async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: "host-only",
        networkConfig: { transportMode: "test" },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: "test" },
      gitOps: stubJoinGitOps,
    });

    const updates: StateUpdate[] = [];
    const allReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for broadcasts")),
        5000,
      );
      joinResult!.onBroadcast((update) => {
        updates.push(update);
        if (updates.length === 3) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    for (let i = 0; i < 3; i++) {
      const fileChange: FileChangeUpdate = {
        type: "file-change",
        peerId: hostResult.peerId,
        filePath: `src/file${i}.ts`,
        patch: VALID_PATCH,
        baseHash: hashContent(`content-${i}`),
        resultHash: hashContent(`content-${i + 1}`),
        timestamp: Date.now() + i,
      };
      hostResult.broadcastHub.broadcast(fileChange);
    }

    await allReceived;
    expect(updates).toHaveLength(3);
    expect(updates.map((u) => (u as FileChangeUpdate).filePath)).toEqual([
      "src/file0.ts",
      "src/file1.ts",
      "src/file2.ts",
    ]);
  }, 30_000);
});
