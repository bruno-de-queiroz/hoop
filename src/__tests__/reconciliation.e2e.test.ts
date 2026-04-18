import { describe, it, expect, afterEach } from "vitest";
import {
  createSession,
  stubGitOps,
  defaultAdmissionHandler,
  type CreateSessionResult,
} from "../session/createSession.js";
import {
  joinSession,
  stubJoinGitOps,
  type JoinSessionResult,
} from "../session/joinSession.js";
import { SessionStore } from "../session/session.js";
import type {
  StateUpdate,
  CursorUpdate,
  MetadataUpdate,
  FileChangeUpdate,
} from "../state/stateUpdate.js";
import { hashContent } from "../git/gitBranch.js";

const VALID_PATCH = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 42;
 const c = 3;`;

describe("State reconciliation and concurrency handling", () => {
  let hostResult: CreateSessionResult | undefined;
  let joinResult: JoinSessionResult | undefined;
  let joinResult2: JoinSessionResult | undefined;

  afterEach(async () => {
    joinResult?.stopAckInterval?.();
    joinResult2?.stopAckInterval?.();
    await Promise.all([
      hostResult?.node?.stop(),
      joinResult?.node?.stop(),
      joinResult2?.node?.stop(),
    ]);
    hostResult = undefined;
    joinResult = undefined;
    joinResult2 = undefined;
  });

  // -----------------------------------------------------------------------
  // Sequence numbering
  // -----------------------------------------------------------------------

  describe("Sequence numbering", () => {
    it("joiner tracks monotonically increasing seqNos via getLastSeqNo()", async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      const receivedUpdates: StateUpdate[] = [];
      const allReceived = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for broadcasts")),
          5000,
        );
        joinResult!.onBroadcast((update) => {
          receivedUpdates.push(update);
          if (receivedUpdates.length === 3) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      // Host broadcasts 3 cursor updates
      for (let i = 1; i <= 3; i++) {
        const cursor: CursorUpdate = {
          type: "cursor-update",
          peerId: hostResult.peerId,
          filePath: `src/file${i}.ts`,
          line: i,
          column: 0,
          timestamp: Date.now() + i,
        };
        hostResult.broadcastHub.broadcast(cursor);
      }

      await allReceived;

      expect(receivedUpdates).toHaveLength(3);
      // seqNo should be monotonically increasing after all 3 broadcasts
      expect(joinResult!.getLastSeqNo()).toBe(3);
    }, 30_000);

    it("onBroadcast delivers unwrapped StateUpdate (not the envelope)", async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      const received = new Promise<StateUpdate>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out")),
          5000,
        );
        joinResult!.onBroadcast((update) => {
          clearTimeout(timeout);
          resolve(update);
        });
      });

      const cursor: CursorUpdate = {
        type: "cursor-update",
        peerId: hostResult.peerId,
        filePath: "src/index.ts",
        line: 10,
        column: 5,
        timestamp: 1000,
      };
      hostResult.broadcastHub.broadcast(cursor);

      const update = await received;

      // Should receive the raw StateUpdate, not a BroadcastEnvelope
      expect(update).not.toHaveProperty("seqNo");
      expect(update).toEqual(cursor);
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // State accumulation (late-joiner)
  // -----------------------------------------------------------------------

  describe("State accumulation (late-joiner)", () => {
    it("late joiner receives accumulated cursor and metadata from earlier peer", async () => {
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

      // Peer 1 joins and sends cursor + metadata
      joinResult = await joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress: hostResult.listenAddresses[0],
        email: 'test@example.com',
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const peer1Id = joinResult.localPeerId;

      const cursor: CursorUpdate = {
        type: "cursor-update",
        peerId: peer1Id,
        filePath: "src/app.ts",
        line: 5,
        column: 3,
        timestamp: Date.now(),
      };
      await joinResult.sendUpdate(cursor);

      const meta: MetadataUpdate = {
        type: "metadata-update",
        peerId: peer1Id,
        key: "theme",
        value: "dark",
        timestamp: Date.now(),
      };
      await joinResult.sendUpdate(meta);

      // Wait for accumulator to process updates
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Peer 2 joins after peer 1's updates — should receive accumulatedState
      joinResult2 = await joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress: hostResult.listenAddresses[0],
        email: 'test@example.com',
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      });

      const accumulated = joinResult2.accumulatedState;
      expect(accumulated).toBeDefined();
      expect(accumulated!.cursors[peer1Id]).toBeDefined();
      expect(accumulated!.cursors[peer1Id]["src/app.ts"]).toMatchObject({
        type: "cursor-update",
        filePath: "src/app.ts",
        line: 5,
        column: 3,
      });
      expect(accumulated!.metadata["theme"]).toMatchObject({
        type: "metadata-update",
        key: "theme",
        value: "dark",
      });
    }, 30_000);
  });

  describe("Hot Seat lock reconciliation", () => {
    it("late joiner receives the current lock holder in accumulated state", async () => {
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
        email: "test@example.com",
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const acquire = await joinResult.acquireLock();
      expect(acquire).toEqual({ acquired: true, holder: joinResult.localPeerId });

      joinResult2 = await joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress: hostResult.listenAddresses[0],
        email: "test@example.com",
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      });

      expect(joinResult2.accumulatedState?.lock).toMatchObject({
        holderPeerId: joinResult.localPeerId,
        status: "busy",
      });
      expect(joinResult2.accumulatedState?.lock.acquiredAt).toBeTypeOf("number");
    }, 30_000);

    it("host serializes concurrent lock acquisition attempts", async () => {
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
        email: "test@example.com",
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      });

      joinResult2 = await joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress: hostResult.listenAddresses[0],
        email: "test@example.com",
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const [first, second] = await Promise.all([
        joinResult.acquireLock(),
        joinResult2.acquireLock(),
      ]);

      const results = [first, second];
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
      const winner = results.find((result) => result.acquired)!;
      const loser = results.find((result) => !result.acquired)!;
      expect(loser.holder).toBe(winner.holder);
      expect(hostResult.accumulator.getSnapshot().lock.holderPeerId).toBe(winner.holder);
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // Replay buffer
  // -----------------------------------------------------------------------

  describe("Replay buffer", () => {
    it("new peer can replay all buffered updates since seqNo 0", async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Broadcast 3 updates through the joiner (so they go into the replay buffer)
      for (let i = 1; i <= 3; i++) {
        const cursor: CursorUpdate = {
          type: "cursor-update",
          peerId: joinResult.localPeerId,
          filePath: `src/file${i}.ts`,
          line: i,
          column: 0,
          timestamp: Date.now() + i,
        };
        await joinResult.sendUpdate(cursor);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      // A second joiner requests a replay of everything since seq 0
      joinResult2 = await joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress: hostResult.listenAddresses[0],
        email: 'test@example.com',
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      });

      const syncResponse = await joinResult2.requestReplay(0);

      expect(syncResponse.replayedUpdates).toBeDefined();
      expect(syncResponse.replayedUpdates!.length).toBe(3);

      // seqNos in replayed envelopes should be increasing
      const seqNos = syncResponse.replayedUpdates!.map((e) => e.seqNo);
      for (let i = 1; i < seqNos.length; i++) {
        expect(seqNos[i]).toBeGreaterThan(seqNos[i - 1]);
      }

      // currentSeqNo in the sync response matches the latest seqNo in the buffer
      expect(syncResponse.currentSeqNo).toBe(seqNos[seqNos.length - 1]);
    }, 30_000);

    it("replayedUpdates contains correct update payloads", async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      const cursor: CursorUpdate = {
        type: "cursor-update",
        peerId: joinResult.localPeerId,
        filePath: "src/main.ts",
        line: 42,
        column: 7,
        timestamp: 9999,
      };
      await joinResult.sendUpdate(cursor);

      await new Promise((resolve) => setTimeout(resolve, 100));

      joinResult2 = await joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress: hostResult.listenAddresses[0],
        email: 'test@example.com',
        networkConfig: { transportMode: "test" },
        gitOps: stubJoinGitOps,
      });

      const syncResponse = await joinResult2.requestReplay(0);

      expect(syncResponse.replayedUpdates).toHaveLength(1);
      expect(syncResponse.replayedUpdates![0].update).toMatchObject({
        type: "cursor-update",
        filePath: "src/main.ts",
        line: 42,
        column: 7,
      });
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // Conflict resolution — metadata LWW
  // -----------------------------------------------------------------------

  describe("Conflict resolution — metadata LWW", () => {
    it("older metadata update is rejected with stale-metadata reason", async () => {
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

      // Peer 1 sends metadata at t=1000 — accepted
      const newerMeta: MetadataUpdate = {
        type: "metadata-update",
        peerId: joinResult.localPeerId,
        key: "theme",
        value: "dark",
        timestamp: 1000,
      };
      const response1 = await joinResult.sendUpdate(newerMeta);
      expect(response1.accepted).toBe(true);

      // Peer 2 sends metadata at t=500 (stale) — should be rejected
      const olderMeta: MetadataUpdate = {
        type: "metadata-update",
        peerId: joinResult2.localPeerId,
        key: "theme",
        value: "light",
        timestamp: 500,
      };
      const response2 = await joinResult2.sendUpdate(olderMeta);
      expect(response2.accepted).toBe(false);
      expect(response2.reason).toBe("stale-metadata");

      // Accumulator still holds the original (t=1000) value
      const snapshot = hostResult.accumulator.getSnapshot();
      expect(snapshot.metadata["theme"]).toMatchObject({
        value: "dark",
        timestamp: 1000,
      });
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // Conflict resolution — file-change baseHash mismatch
  // -----------------------------------------------------------------------

  describe("Conflict resolution — file-change baseHash mismatch", () => {
    it("file-change with wrong baseHash is rejected with base-hash-mismatch", async () => {
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

      const originalContent = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
      const updatedContent = "const a = 1;\nconst b = 42;\nconst c = 3;\n";

      // Peer 1 sends a valid file-change — accepted, updates accumulator's fileHash
      const fileChange1: FileChangeUpdate = {
        type: "file-change",
        peerId: joinResult.localPeerId,
        filePath: "src/index.ts",
        patch: VALID_PATCH,
        baseHash: hashContent(originalContent),
        resultHash: hashContent(updatedContent),
        timestamp: Date.now(),
      };
      const response1 = await joinResult.sendUpdate(fileChange1);
      expect(response1.accepted).toBe(true);

      // Peer 2 sends a file-change with the WRONG baseHash (uses original, not updated)
      const fileChange2: FileChangeUpdate = {
        type: "file-change",
        peerId: joinResult2.localPeerId,
        filePath: "src/index.ts",
        patch: VALID_PATCH,
        baseHash: hashContent(originalContent), // stale — doesn't match resultHash from peer 1
        resultHash: hashContent("const a = 1;\nconst b = 99;\nconst c = 3;\n"),
        timestamp: Date.now(),
      };
      const response2 = await joinResult2.sendUpdate(fileChange2);
      expect(response2.accepted).toBe(false);
      expect(response2.reason).toBe("base-hash-mismatch");
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // UpdateResponse on success
  // -----------------------------------------------------------------------

  describe("UpdateResponse on success", () => {
    it("sendUpdate returns { accepted: true, seqNo: N } with N > 0", async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      const cursor: CursorUpdate = {
        type: "cursor-update",
        peerId: joinResult.localPeerId,
        filePath: "src/index.ts",
        line: 1,
        column: 0,
        timestamp: Date.now(),
      };

      const response = await joinResult.sendUpdate(cursor);

      expect(response.accepted).toBe(true);
      expect(typeof response.seqNo).toBe("number");
      expect(response.seqNo).toBeGreaterThan(0);
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // ACK tracking
  // -----------------------------------------------------------------------

  describe("ACK tracking", () => {
    it("explicit sendAck() records joiner peerId in getPeerAckStatus()", async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      await joinResult.sendAck();

      // Small wait for the ACK message to be processed on the host side
      await new Promise((resolve) => setTimeout(resolve, 100));

      const ackStatus = hostResult.broadcastHub.getPeerAckStatus();
      expect(ackStatus.has(joinResult.localPeerId)).toBe(true);
    }, 30_000);

    it("peers that have acked are not flagged as slow when caught up", async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send a few updates so seqNo advances
      for (let i = 0; i < 3; i++) {
        const cursor: CursorUpdate = {
          type: "cursor-update",
          peerId: joinResult.localPeerId,
          filePath: `src/f${i}.ts`,
          line: i,
          column: 0,
          timestamp: Date.now() + i,
        };
        await joinResult.sendUpdate(cursor);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Joiner acks the latest seqNo it received
      await joinResult.sendAck();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // With a threshold of 5, the joiner should not be slow (it's caught up)
      const slowPeers = hostResult.broadcastHub.getSlowPeers(5);
      expect(slowPeers).not.toContain(joinResult.localPeerId);
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // Peer disconnect cleanup
  // -----------------------------------------------------------------------

  describe("Peer disconnect cleanup", () => {
    it("accumulator removes peer data on disconnect", async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      const peer1Id = joinResult.localPeerId;

      // Peer sends cursor data
      const cursor: CursorUpdate = {
        type: "cursor-update",
        peerId: peer1Id,
        filePath: "src/editor.ts",
        line: 10,
        column: 2,
        timestamp: Date.now(),
      };
      await joinResult.sendUpdate(cursor);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Confirm it's in the accumulator before disconnect
      let snapshot = hostResult.accumulator.getSnapshot();
      expect(snapshot.cursors[peer1Id]).toBeDefined();

      // Stop the ACK interval before disconnecting
      joinResult.stopAckInterval();

      // Disconnect joiner
      await joinResult.node.stop();

      // Wait for the peer:disconnect event to propagate
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Accumulator should have removed peer's data
      snapshot = hostResult.accumulator.getSnapshot();
      expect(snapshot.cursors[peer1Id]).toBeUndefined();
    }, 30_000);

    it("broadcastHub removes peer from subscribers on disconnect", async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Confirm joiner is subscribed before disconnect
      const peer1Id = joinResult.localPeerId;
      expect(hostResult.broadcastHub.getSubscribers()).toContain(peer1Id);

      // Stop the ACK interval before disconnecting
      joinResult.stopAckInterval();

      // Disconnect the joiner
      await joinResult.node.stop();

      // Wait for the peer:disconnect event to propagate
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Joiner should be removed from subscribers
      expect(hostResult.broadcastHub.getSubscribers()).not.toContain(peer1Id);
    }, 30_000);
  });
});
