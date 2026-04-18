import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { unlinkSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHoopMcpServer, type HoopMcpDeps } from "../server.js";
import { stubGitOps } from "../../session/createSession.js";
import { stubJoinGitOps } from "../../session/joinSession.js";
import { hashContent } from "../../git/gitBranch.js";
import { dirname } from "node:path";
import type { OutboundUpdatesRegistry } from "../../state/outboundUpdatesReader.js";
import { LockStatusWriter } from "../../state/lockStatusWriter.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeDeps(label: string): HoopMcpDeps {
  const base = join(tmpdir(), `hoop-e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return {
    gitOps: stubGitOps,
    joinGitOps: stubJoinGitOps,
    conflictRegistryPath: `${base}-conflicts.json`,
    pendingUpdatesRegistryPath: `${base}-pending-updates.json`,
    pendingAdmissionsRegistryPath: `${base}-pending-admissions.json`,
    outboundUpdatesRegistryPath: `${base}-outbound-updates.json`,
    lockStatusRegistryPath: `${base}-lock-status.json`,
    sessionStatusPath: `${base}-session-status.json`,
  };
}

function allRegistryPaths(deps: HoopMcpDeps): string[] {
  return [
    deps.conflictRegistryPath,
    deps.pendingUpdatesRegistryPath,
    deps.pendingAdmissionsRegistryPath,
    deps.outboundUpdatesRegistryPath,
    deps.lockStatusRegistryPath,
    deps.sessionStatusPath,
  ].filter(Boolean) as string[];
}

async function createMcpInstance(deps: HoopMcpDeps) {
  const { server, state } = createHoopMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);

  return { server, state, client };
}

type McpInstance = Awaited<ReturnType<typeof createMcpInstance>>;
type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

function resultText(result: CallToolResult): string {
  return (result.content as Array<{ type: string; text: string }>)?.[0]?.text ?? "";
}

function parseJson(result: CallToolResult): unknown {
  if (result.isError) {
    throw new Error(`Tool returned error: ${resultText(result)}`);
  }
  return JSON.parse(resultText(result));
}

async function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  if (condition()) return;
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out after ${timeoutMs}ms: ${message}`));
    }, timeoutMs);
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
  });
}

interface ConnectedSession {
  host: McpInstance;
  peer: McpInstance;
  hostDeps: HoopMcpDeps;
  peerDeps: HoopMcpDeps;
  hostData: { sessionCode: string; peerId: string; listenAddresses: string[] };
  peerData: { localPeerId: string; hostPeerId: string; authenticated: boolean; admitted: boolean };
}

/** Sets up a fully connected host+peer session with admission completed. */
async function setupConnectedSession(): Promise<ConnectedSession> {
  const hostDeps = makeDeps("host");
  const peerDeps = makeDeps("peer");
  const host = await createMcpInstance(hostDeps);
  const peer = await createMcpInstance(peerDeps);

  const createResult = await host.client.callTool({
    name: "hoop_create_session",
    arguments: { executionTarget: "host-only" },
  });
  const hostData = parseJson(createResult) as ConnectedSession["hostData"];

  const joinPromise = peer.client.callTool({
    name: "hoop_join_session",
    arguments: {
      sessionCode: hostData.sessionCode,
      hostAddress: hostData.listenAddresses[0],
      email: "peer@example.com",
    },
  });

  await waitFor(
    () => host.state.pendingAdmissions.size > 0,
    "waiting for admission request",
  );

  const admissions = parseJson(
    await host.client.callTool({ name: "hoop_check_admissions", arguments: {} }),
  ) as { requests: Array<{ peerId: string }> };
  await host.client.callTool({
    name: "hoop_admit_peer",
    arguments: { peerId: admissions.requests[0].peerId },
  });

  const joinResult = await joinPromise;
  const peerData = parseJson(joinResult) as ConnectedSession["peerData"];

  return { host, peer, hostDeps, peerDeps, hostData, peerData };
}

const VALID_PATCH_A = `--- a/src/moduleA.ts
+++ b/src/moduleA.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 42;
 const c = 3;`;

const VALID_PATCH_B = `--- a/src/moduleB.ts
+++ b/src/moduleB.ts
@@ -1,3 +1,3 @@
 export const x = 10;
-export const y = 20;
+export const y = 99;
 export const z = 30;`;

// ── Test suite ─────────────────────────────────────────────────────

describe("E2E: two claude-code instances in a hoop session", () => {
  let host: McpInstance | undefined;
  let peer: McpInstance | undefined;
  let hDeps: HoopMcpDeps | undefined;
  let pDeps: HoopMcpDeps | undefined;

  afterEach(async () => {
    if (host?.state.role !== null) {
      try { await host?.client.callTool({ name: "hoop_leave_session", arguments: {} }); } catch { /* ignore */ }
    }
    if (peer?.state.role !== null) {
      try { await peer?.client.callTool({ name: "hoop_leave_session", arguments: {} }); } catch { /* ignore */ }
    }
    try { await host?.client.close(); } catch { /* ignore */ }
    try { await peer?.client.close(); } catch { /* ignore */ }
    try { await host?.server.close(); } catch { /* ignore */ }
    try { await peer?.server.close(); } catch { /* ignore */ }
    host = peer = undefined;

    const paths = [...(hDeps ? allRegistryPaths(hDeps) : []), ...(pDeps ? allRegistryPaths(pDeps) : [])];
    for (const p of paths) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    hDeps = pDeps = undefined;
  });

  // ── Full round-trip ──────────────────────────────────────────────

  it("full round-trip: create → join → admit → edit → broadcast → receive → leave", async () => {
    // --- Step 1: Host creates session ---
    hDeps = makeDeps("host");
    pDeps = makeDeps("peer");
    host = await createMcpInstance(hDeps);

    const createResult = await host.client.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const hostData = parseJson(createResult) as {
      sessionCode: string;
      peerId: string;
      listenAddresses: string[];
    };

    expect(hostData.sessionCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(hostData.listenAddresses.length).toBeGreaterThan(0);
    expect(host.state.role).toBe("host");

    // --- Step 2: Peer joins (joinSession blocks until admitted) ---
    peer = await createMcpInstance(pDeps);

    const joinPromise = peer.client.callTool({
      name: "hoop_join_session",
      arguments: {
        sessionCode: hostData.sessionCode,
        hostAddress: hostData.listenAddresses[0],
        email: "peer@example.com",
      },
    });

    // --- Step 3: Host checks admissions and admits the peer ---
    await waitFor(
      () => host!.state.pendingAdmissions.size > 0,
      "waiting for admission request",
    );

    const admissionsResult = await host.client.callTool({
      name: "hoop_check_admissions",
      arguments: {},
    });
    const admissionsData = parseJson(admissionsResult) as {
      count: number;
      requests: Array<{ peerId: string; email: string }>;
    };
    expect(admissionsData.count).toBe(1);
    expect(admissionsData.requests[0].email).toBe("peer@example.com");

    const peerPeerId = admissionsData.requests[0].peerId;

    await host.client.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: peerPeerId },
    });

    const joinResult = await joinPromise;
    const peerData = parseJson(joinResult) as {
      localPeerId: string;
      hostPeerId: string;
      authenticated: boolean;
      admitted: boolean;
    };
    expect(peerData.admitted).toBe(true);
    expect(peerData.hostPeerId).toBe(hostData.peerId);
    expect(peer.state.role).toBe("peer");

    // Verify both sides see consistent state
    const hostStatus = parseJson(
      await host.client.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { role: string; peerCount: number; connectedPeers: string[] };
    expect(hostStatus.role).toBe("host");
    expect(hostStatus.peerCount).toBe(1);
    expect(hostStatus.connectedPeers).toContain(peerData.localPeerId);

    const peerStatus = parseJson(
      await peer.client.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { role: string; hostPeerId: string };
    expect(peerStatus.role).toBe("peer");
    expect(peerStatus.hostPeerId).toBe(hostData.peerId);

    // --- Step 4: Host edits a file → peer receives via hoop_check_updates ---
    const hostFileChange = await host.client.callTool({
      name: "hoop_send_update",
      arguments: {
        type: "file-change",
        filePath: "src/moduleA.ts",
        patch: VALID_PATCH_A,
        baseHash: hashContent("const a = 1;\nconst b = 2;\nconst c = 3;\n"),
        resultHash: hashContent("const a = 1;\nconst b = 42;\nconst c = 3;\n"),
      },
    });
    const hostChangeData = parseJson(hostFileChange) as { accepted: boolean; seqNo: number };
    expect(hostChangeData.accepted).toBe(true);
    expect(hostChangeData.seqNo).toBeGreaterThan(0);

    await waitFor(
      () => peer!.state.pendingUpdates.length > 0,
      "waiting for host update to reach peer",
    );

    // Peer drains pending updates (simulates PreToolUse hook calling hoop_check_updates)
    const peerUpdates = parseJson(
      await peer.client.callTool({ name: "hoop_check_updates", arguments: {} }),
    ) as { count: number; updates: Array<{ type: string; filePath: string; patch: string }> };
    expect(peerUpdates.count).toBeGreaterThanOrEqual(1);

    const fileChangeFromHost = peerUpdates.updates.find(
      (u) => u.type === "file-change" && u.filePath === "src/moduleA.ts",
    );
    expect(fileChangeFromHost).toBeDefined();
    expect(fileChangeFromHost!.patch).toBe(VALID_PATCH_A);

    // --- Step 5: Peer edits a different file → host receives ---
    const peerFileChange = await peer.client.callTool({
      name: "hoop_send_update",
      arguments: {
        type: "file-change",
        filePath: "src/moduleB.ts",
        patch: VALID_PATCH_B,
        baseHash: hashContent("export const x = 10;\nexport const y = 20;\nexport const z = 30;\n"),
        resultHash: hashContent("export const x = 10;\nexport const y = 99;\nexport const z = 30;\n"),
      },
    });
    const peerChangeData = parseJson(peerFileChange) as { accepted: boolean; seqNo: number };
    expect(peerChangeData.accepted).toBe(true);

    await waitFor(
      () => host!.state.pendingUpdates.length > 0,
      "waiting for peer update to reach host",
    );

    // Host drains pending updates
    const hostUpdates = parseJson(
      await host.client.callTool({ name: "hoop_check_updates", arguments: {} }),
    ) as { count: number; updates: Array<{ type: string; filePath: string; patch: string; peerId: string }> };
    expect(hostUpdates.count).toBeGreaterThanOrEqual(1);

    const fileChangeFromPeer = hostUpdates.updates.find(
      (u) => u.type === "file-change" && u.filePath === "src/moduleB.ts",
    );
    expect(fileChangeFromPeer).toBeDefined();
    expect(fileChangeFromPeer!.patch).toBe(VALID_PATCH_B);
    expect(fileChangeFromPeer!.peerId).toBe(peerData.localPeerId);

    // Second drain is empty (queue was drained)
    const hostUpdates2 = parseJson(
      await host.client.callTool({ name: "hoop_check_updates", arguments: {} }),
    ) as { count: number };
    expect(hostUpdates2.count).toBe(0);

    // --- Step 6: Peer leaves gracefully ---
    const peerLeave = parseJson(
      await peer.client.callTool({ name: "hoop_leave_session", arguments: {} }),
    ) as { left: boolean; previousRole: string };
    expect(peerLeave.left).toBe(true);
    expect(peerLeave.previousRole).toBe("peer");
    expect(peer.state.role).toBeNull();

    // --- Step 7: Host leaves gracefully ---
    const hostLeave = parseJson(
      await host.client.callTool({ name: "hoop_leave_session", arguments: {} }),
    ) as { left: boolean; previousRole: string };
    expect(hostLeave.left).toBe(true);
    expect(hostLeave.previousRole).toBe("host");
    expect(host.state.role).toBeNull();
  }, 60_000);

  it("the host is authoritative for lock acquisition and release", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    const hostLock = parseJson(
      await host.client.callTool({ name: "hoop_acquire_lock", arguments: {} }),
    ) as { acquired: boolean; holder: string };
    expect(hostLock.acquired).toBe(true);
    expect(hostLock.holder).toBe(host.state.hostSession!.peerId);

    await waitFor(
      () => peer!.state.peerSession?.getLockStatus().holderPeerId === host!.state.hostSession!.peerId,
      "waiting for host lock broadcast to reach peer",
    );

    const peerAcquire = parseJson(
      await peer.client.callTool({ name: "hoop_acquire_lock", arguments: {} }),
    ) as { acquired: boolean; holder: string };
    expect(peerAcquire.acquired).toBe(false);
    expect(peerAcquire.holder).toBe(host.state.hostSession!.peerId);

    const peerRelease = parseJson(
      await peer.client.callTool({ name: "hoop_release_lock", arguments: {} }),
    ) as { released: boolean; holder: string };
    expect(peerRelease.released).toBe(false);
    expect(peerRelease.holder).toBe(host.state.hostSession!.peerId);

    const hostRelease = parseJson(
      await host.client.callTool({ name: "hoop_release_lock", arguments: {} }),
    ) as { released: boolean; holder: null };
    expect(hostRelease).toEqual({ released: true, holder: null });

    await waitFor(
      () => peer!.state.peerSession?.getLockStatus().status === "free",
      "waiting for lock release to reach peer",
    );
  }, 60_000);

  // ── Lock status file reflects lock state changes ─────────────────

  it("lock status file tracks acquire and release across host and peer", async () => {
    const session = await setupConnectedSession();
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = session);

    // Initially both lock status files should show free
    const hostLockBefore = LockStatusWriter.readRegistry(hDeps!.lockStatusRegistryPath!);
    expect(hostLockBefore).not.toBeNull();
    expect(hostLockBefore!.status).toBe("free");
    expect(hostLockBefore!.acquiredAt).toBeNull();
    expect(hostLockBefore!.selfPeerId).toBe(session.hostData.peerId);
    expect(hostLockBefore!.sessionPid).toBe(process.pid);

    const peerLockBefore = LockStatusWriter.readRegistry(pDeps!.lockStatusRegistryPath!);
    expect(peerLockBefore).not.toBeNull();
    expect(peerLockBefore!.status).toBe("free");

    // Host acquires lock → host file should show busy with self as holder
    await host.client.callTool({ name: "hoop_acquire_lock", arguments: {} });

    const hostLockAfterAcquire = LockStatusWriter.readRegistry(hDeps!.lockStatusRegistryPath!);
    expect(hostLockAfterAcquire!.status).toBe("busy");
    expect(hostLockAfterAcquire!.holderPeerId).toBe(session.hostData.peerId);
    expect(hostLockAfterAcquire!.acquiredAt).toBeGreaterThan(0);

    // Wait for lock broadcast to reach peer → peer file should show busy
    await waitFor(
      () => LockStatusWriter.readRegistry(pDeps!.lockStatusRegistryPath!)?.status === "busy",
      "waiting for lock status file on peer to reflect busy",
    );
    const peerLockAfterAcquire = LockStatusWriter.readRegistry(pDeps!.lockStatusRegistryPath!);
    expect(peerLockAfterAcquire!.holderPeerId).toBe(session.hostData.peerId);
    expect(peerLockAfterAcquire!.selfPeerId).not.toBe(session.hostData.peerId);

    // Host releases lock → both files should show free
    await host.client.callTool({ name: "hoop_release_lock", arguments: {} });

    const hostLockAfterRelease = LockStatusWriter.readRegistry(hDeps!.lockStatusRegistryPath!);
    expect(hostLockAfterRelease!.status).toBe("free");
    expect(hostLockAfterRelease!.holderPeerId).toBeNull();

    await waitFor(
      () => LockStatusWriter.readRegistry(pDeps!.lockStatusRegistryPath!)?.status === "free",
      "waiting for lock status file on peer to reflect free",
    );
  }, 60_000);

  it("lock status file is cleaned up on session leave", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    // Verify files exist
    expect(LockStatusWriter.readRegistry(hDeps!.lockStatusRegistryPath!)).not.toBeNull();
    expect(LockStatusWriter.readRegistry(pDeps!.lockStatusRegistryPath!)).not.toBeNull();

    // Leave sessions
    await peer.client.callTool({ name: "hoop_leave_session", arguments: {} });
    await host.client.callTool({ name: "hoop_leave_session", arguments: {} });

    // Files should be removed (check both existence and readRegistry)
    expect(existsSync(hDeps!.lockStatusRegistryPath!)).toBe(false);
    expect(existsSync(pDeps!.lockStatusRegistryPath!)).toBe(false);
    expect(LockStatusWriter.readRegistry(hDeps!.lockStatusRegistryPath!)).toBeNull();
    expect(LockStatusWriter.readRegistry(pDeps!.lockStatusRegistryPath!)).toBeNull();
  }, 60_000);

  // ── Conflict detection across instances ──────────────────────────

  it("peer detects conflict when host is editing the same file", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    // Host sends a file-change on src/shared.ts
    await host.client.callTool({
      name: "hoop_send_update",
      arguments: {
        type: "file-change",
        filePath: "src/shared.ts",
        patch: VALID_PATCH_A,
        baseHash: hashContent("original"),
        resultHash: hashContent("modified"),
      },
    });

    await waitFor(
      () => peer!.state.pendingUpdates.length > 0,
      "waiting for host file-change to reach peer",
    );

    // Peer checks for conflict on the same file (simulates PreToolUse conflict hook)
    const conflictResult = parseJson(
      await peer.client.callTool({
        name: "hoop_check_conflicts",
        arguments: { filePath: "src/shared.ts" },
      }),
    ) as { hasConflict: boolean; conflict: { peerId: string; type: string } | null };

    expect(conflictResult.hasConflict).toBe(true);
    expect(conflictResult.conflict).not.toBeNull();
    expect(conflictResult.conflict!.type).toBe("file-change");
  }, 60_000);

  // ── No orphaned processes after both leave ───────────────────────

  it("no active state remains after both instances leave", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    // Both leave
    await peer.client.callTool({ name: "hoop_leave_session", arguments: {} });
    await host.client.callTool({ name: "hoop_leave_session", arguments: {} });

    // Verify all state is cleaned up
    expect(host.state.role).toBeNull();
    expect(host.state.hostSession).toBeNull();
    expect(host.state.pendingUpdates).toHaveLength(0);
    expect(host.state.pendingAdmissions.size).toBe(0);
    expect(host.state.activeEditsTracker).toBeNull();
    expect(host.state.pendingUpdatesWriter).toBeNull();
    expect(host.state.pendingAdmissionsWriter).toBeNull();
    expect(host.state.outboundUpdatesReader).toBeNull();
    expect(host.state.lockStatusWriter).toBeNull();

    expect(peer.state.role).toBeNull();
    expect(peer.state.peerSession).toBeNull();
    expect(peer.state.pendingUpdates).toHaveLength(0);
    expect(peer.state.activeEditsTracker).toBeNull();
    expect(peer.state.pendingUpdatesWriter).toBeNull();
    expect(peer.state.outboundUpdatesReader).toBeNull();
    expect(peer.state.lockStatusWriter).toBeNull();

    // Both report inactive status
    const hostStatus = parseJson(
      await host.client.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { active: boolean };
    expect(hostStatus.active).toBe(false);

    const peerStatus = parseJson(
      await peer.client.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { active: boolean };
    expect(peerStatus.active).toBe(false);
  }, 60_000);

  // ── Bidirectional update exchange ────────────────────────────────

  it("both instances exchange multiple updates bidirectionally", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    // Host sends 3 cursor updates
    for (let i = 0; i < 3; i++) {
      await host.client.callTool({
        name: "hoop_send_update",
        arguments: {
          type: "cursor-update",
          filePath: `src/host-file-${i}.ts`,
          line: i + 1,
          column: 0,
        },
      });
    }

    // Peer sends 2 metadata updates
    for (let i = 0; i < 2; i++) {
      await peer.client.callTool({
        name: "hoop_send_update",
        arguments: {
          type: "metadata-update",
          key: `peer-key-${i}`,
          value: `peer-value-${i}`,
        },
      });
    }

    await waitFor(
      () => peer!.state.pendingUpdates.length >= 3,
      "waiting for all host cursor updates to reach peer",
    );
    await waitFor(
      () => host!.state.pendingUpdates.length >= 2,
      "waiting for all peer metadata updates to reach host",
    );

    // Peer should have received all 3 host cursor updates
    const peerUpdates = parseJson(
      await peer.client.callTool({ name: "hoop_check_updates", arguments: {} }),
    ) as { count: number; updates: Array<{ type: string; filePath?: string }> };

    const cursorUpdates = peerUpdates.updates.filter((u) => u.type === "cursor-update");
    expect(cursorUpdates).toHaveLength(3);
    expect(cursorUpdates.map((u) => u.filePath).sort()).toEqual([
      "src/host-file-0.ts",
      "src/host-file-1.ts",
      "src/host-file-2.ts",
    ]);

    // Host should have received all 2 peer metadata updates
    const hostUpdates = parseJson(
      await host.client.callTool({ name: "hoop_check_updates", arguments: {} }),
    ) as { count: number; updates: Array<{ type: string; key?: string }> };

    const metaUpdates = hostUpdates.updates.filter((u) => u.type === "metadata-update");
    expect(metaUpdates).toHaveLength(2);
    expect(metaUpdates.map((u) => u.key).sort()).toEqual(["peer-key-0", "peer-key-1"]);
  }, 60_000);

  // ── Peer leave while host continues ──────────────────────────────

  it("host continues operating after peer disconnects", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    // Peer leaves
    await peer.client.callTool({ name: "hoop_leave_session", arguments: {} });

    // Wait for disconnect to propagate to host via broadcastHub subscriber count
    await waitFor(
      () => host!.state.hostSession?.broadcastHub.getSubscriberCount() === 0,
      "waiting for host to detect peer disconnect",
    );

    // Host is still active and can send updates
    const hostStatus = parseJson(
      await host.client.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { active: boolean; role: string; peerCount: number };
    expect(hostStatus.active).toBe(true);
    expect(hostStatus.role).toBe("host");
    expect(hostStatus.peerCount).toBe(0);

    // Host can still send updates (to replay buffer for future peers)
    const sendResult = parseJson(
      await host.client.callTool({
        name: "hoop_send_update",
        arguments: {
          type: "metadata-update",
          key: "still-alive",
          value: "true",
        },
      }),
    ) as { accepted: boolean };
    expect(sendResult.accepted).toBe(true);
  }, 60_000);

  // ── Denial flow ─────────────────────────────────────────────────

  it("denied peer receives an error and host state is cleaned up", async () => {
    hDeps = makeDeps("host");
    pDeps = makeDeps("peer");
    host = await createMcpInstance(hDeps);
    peer = await createMcpInstance(pDeps);

    const createResult = await host.client.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const hostData = parseJson(createResult) as { sessionCode: string; listenAddresses: string[] };

    const joinPromise = peer.client.callTool({
      name: "hoop_join_session",
      arguments: {
        sessionCode: hostData.sessionCode,
        hostAddress: hostData.listenAddresses[0],
        email: "untrusted@example.com",
      },
    });

    await waitFor(
      () => host!.state.pendingAdmissions.size > 0,
      "waiting for admission request",
    );

    const admissions = parseJson(
      await host.client.callTool({ name: "hoop_check_admissions", arguments: {} }),
    ) as { requests: Array<{ peerId: string; email: string }> };
    expect(admissions.requests[0].email).toBe("untrusted@example.com");

    // Host denies the peer
    const denyResult = parseJson(
      await host.client.callTool({
        name: "hoop_deny_peer",
        arguments: { peerId: admissions.requests[0].peerId },
      }),
    ) as { denied: boolean; peerId: string };
    expect(denyResult.denied).toBe(true);

    // Join should resolve with an error
    const joinResult = await joinPromise;
    expect(joinResult.isError).toBe(true);
    expect(resultText(joinResult)).toContain("Admission denied");

    // Peer state should not be active
    expect(peer.state.role).toBeNull();

    // Host admission queue should be empty
    expect(host.state.pendingAdmissions.size).toBe(0);
  }, 60_000);

  // ── Double-create prevention ────────────────────────────────────

  it("creating a session while one is active returns an error", async () => {
    hDeps = makeDeps("host");
    host = await createMcpInstance(hDeps);

    await host.client.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    expect(host.state.role).toBe("host");

    // Second create should fail
    const secondCreate = await host.client.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    expect(secondCreate.isError).toBe(true);
    expect(resultText(secondCreate)).toContain("Session already active");
  }, 60_000);

  // ── Double-join prevention ──────────────────────────────────────

  it("joining a session while one is active returns an error", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    // Peer tries to join again while already connected
    const secondJoin = await peer.client.callTool({
      name: "hoop_join_session",
      arguments: {
        sessionCode: "ABC-123",
        hostAddress: "/ip4/127.0.0.1/tcp/9999",
        email: "peer@example.com",
      },
    });
    expect(secondJoin.isError).toBe(true);
    expect(resultText(secondJoin)).toContain("Session already active");
  }, 60_000);

  // ── Host leaves first ───────────────────────────────────────────

  it("peer detects host departure and can leave cleanly", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    // Host leaves while peer is still connected
    const hostLeave = parseJson(
      await host.client.callTool({ name: "hoop_leave_session", arguments: {} }),
    ) as { left: boolean; previousRole: string };
    expect(hostLeave.left).toBe(true);
    expect(host.state.role).toBeNull();

    // Peer can still leave gracefully (no crash or hang)
    const peerLeave = parseJson(
      await peer.client.callTool({ name: "hoop_leave_session", arguments: {} }),
    ) as { left: boolean; previousRole: string };
    expect(peerLeave.left).toBe(true);
    expect(peerLeave.previousRole).toBe("peer");
    expect(peer.state.role).toBeNull();
  }, 60_000);

  // ── Hook integration: OutboundUpdatesReader → broadcast → peer ──

  it("host PostToolUse hook write is picked up and broadcast to peer", async () => {
    const session = await setupConnectedSession();
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = session);

    // Simulate PostToolUse hook writing to the outbound registry file.
    // In production, the hook shell script writes this JSON after a file-write tool call.
    const registryPath = hDeps!.outboundUpdatesRegistryPath!;
    mkdirSync(dirname(registryPath), { recursive: true });

    const registry: OutboundUpdatesRegistry = {
      updates: [
        {
          filePath: "src/hookTest.ts",
          patch: VALID_PATCH_A,
          baseHash: hashContent("const a = 1;\nconst b = 2;\nconst c = 3;\n"),
          resultHash: hashContent("const a = 1;\nconst b = 42;\nconst c = 3;\n"),
          timestamp: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    };
    writeFileSync(registryPath, JSON.stringify(registry), "utf-8");

    // OutboundUpdatesReader uses watchFile with 500ms interval, so wait for it
    // to drain the file and broadcast through the host's broadcastHub → peer
    await waitFor(
      () => peer!.state.pendingUpdates.length > 0,
      "waiting for hook-originated update to reach peer via OutboundUpdatesReader",
      5_000,
    );

    // Peer drains updates — should see the file change from the hook path
    const peerUpdates = parseJson(
      await peer.client.callTool({ name: "hoop_check_updates", arguments: {} }),
    ) as { count: number; updates: Array<{ type: string; filePath: string; patch: string; peerId: string }> };

    expect(peerUpdates.count).toBeGreaterThanOrEqual(1);
    const hookUpdate = peerUpdates.updates.find(
      (u) => u.type === "file-change" && u.filePath === "src/hookTest.ts",
    );
    expect(hookUpdate).toBeDefined();
    expect(hookUpdate!.patch).toBe(VALID_PATCH_A);
    // The update should be attributed to the host's peerId
    expect(hookUpdate!.peerId).toBe(session.hostData.peerId);
  }, 60_000);

  // ── Error paths: unauthorized & invalid actions ─────────────────

  it("peer cannot call host-only tools", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    const checkAdmissions = await peer.client.callTool({
      name: "hoop_check_admissions",
      arguments: {},
    });
    expect(checkAdmissions.isError).toBe(true);
    expect(resultText(checkAdmissions)).toContain("Only the host");

    const admitPeer = await peer.client.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: "fake-peer-id" },
    });
    expect(admitPeer.isError).toBe(true);
    expect(resultText(admitPeer)).toContain("Only the host");

    const denyPeer = await peer.client.callTool({
      name: "hoop_deny_peer",
      arguments: { peerId: "fake-peer-id" },
    });
    expect(denyPeer.isError).toBe(true);
    expect(resultText(denyPeer)).toContain("Only the host");
  }, 60_000);

  it("host cannot admit or deny a non-existent peer", async () => {
    ({ host, peer, hostDeps: hDeps, peerDeps: pDeps } = await setupConnectedSession());

    const admitResult = await host.client.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: "non-existent-peer-id" },
    });
    expect(admitResult.isError).toBe(true);
    expect(resultText(admitResult)).toContain("No pending admission");

    const denyResult = await host.client.callTool({
      name: "hoop_deny_peer",
      arguments: { peerId: "non-existent-peer-id" },
    });
    expect(denyResult.isError).toBe(true);
    expect(resultText(denyResult)).toContain("No pending admission");
  }, 60_000);

  it("tools require an active session", async () => {
    hDeps = makeDeps("host");
    host = await createMcpInstance(hDeps);

    // No session created yet — all session tools should fail
    const sendUpdate = await host.client.callTool({
      name: "hoop_send_update",
      arguments: {
        type: "metadata-update",
        key: "test",
        value: "test",
      },
    });
    expect(sendUpdate.isError).toBe(true);
    expect(resultText(sendUpdate)).toContain("No active session");

    const checkUpdates = await host.client.callTool({
      name: "hoop_check_updates",
      arguments: {},
    });
    expect(checkUpdates.isError).toBe(true);
    expect(resultText(checkUpdates)).toContain("No active session");

    const acquireLock = await host.client.callTool({
      name: "hoop_acquire_lock",
      arguments: {},
    });
    expect(acquireLock.isError).toBe(true);
    expect(resultText(acquireLock)).toContain("No active session");

    const lockStatus = parseJson(
      await host.client.callTool({ name: "hoop_lock_status", arguments: {} }),
    ) as { status: string; holderPeerId: string | null; acquiredAt: number | null };
    expect(lockStatus).toEqual({
      status: "free",
      holderPeerId: null,
      acquiredAt: null,
    });

    const getStatus = await host.client.callTool({
      name: "hoop_get_status",
      arguments: {},
    });
    const statusData = parseJson(getStatus) as { active: boolean };
    expect(statusData.active).toBe(false);
  }, 60_000);
});
