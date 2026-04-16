import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHoopMcpServer, type HoopMcpDeps } from "../server.js";
import { stubGitOps } from "../../session/createSession.js";
import { stubJoinGitOps } from "../../session/joinSession.js";
import { hashContent } from "../../git/gitBranch.js";

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
    sessionStatusPath: `${base}-session-status.json`,
  };
}

function allRegistryPaths(deps: HoopMcpDeps): string[] {
  return [
    deps.conflictRegistryPath,
    deps.pendingUpdatesRegistryPath,
    deps.pendingAdmissionsRegistryPath,
    deps.outboundUpdatesRegistryPath,
    deps.sessionStatusPath,
  ].filter(Boolean) as string[];
}

async function createMcpInstance(deps: HoopMcpDeps) {
  const { server, state, gracefulShutdown } = createHoopMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);

  return { server, state, client, gracefulShutdown };
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

function parseJson(result: CallToolResult): unknown {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text);
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
  const hostDeps = makeDeps("host");
  const peerDeps = makeDeps("peer");

  let hostClient: Client | undefined;
  let hostServer: Awaited<ReturnType<typeof createHoopMcpServer>>["server"] | undefined;
  let hostState: Awaited<ReturnType<typeof createHoopMcpServer>>["state"] | undefined;

  let peerClient: Client | undefined;
  let peerServer: Awaited<ReturnType<typeof createHoopMcpServer>>["server"] | undefined;
  let peerState: Awaited<ReturnType<typeof createHoopMcpServer>>["state"] | undefined;

  afterEach(async () => {
    // Graceful shutdown through MCP tools
    if (hostState?.role !== null) {
      try { await hostClient?.callTool({ name: "hoop_leave_session", arguments: {} }); } catch { /* ignore */ }
    }
    if (peerState?.role !== null) {
      try { await peerClient?.callTool({ name: "hoop_leave_session", arguments: {} }); } catch { /* ignore */ }
    }
    await hostClient?.close();
    await peerClient?.close();
    await hostServer?.close();
    await peerServer?.close();
    hostClient = hostServer = hostState = undefined;
    peerClient = peerServer = peerState = undefined;

    for (const p of [...allRegistryPaths(hostDeps), ...allRegistryPaths(peerDeps)]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  });

  // ── Full round-trip ──────────────────────────────────────────────

  it("full round-trip: create → join → admit → edit → broadcast → receive → leave", async () => {
    // --- Step 1: Host creates session ---
    ({ server: hostServer, state: hostState, client: hostClient } = await createMcpInstance(hostDeps));

    const createResult = await hostClient!.callTool({
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
    expect(hostState!.role).toBe("host");

    // --- Step 2: Peer joins in parallel (joinSession blocks until admitted) ---
    ({ server: peerServer, state: peerState, client: peerClient } = await createMcpInstance(peerDeps));

    const joinPromise = peerClient!.callTool({
      name: "hoop_join_session",
      arguments: {
        sessionCode: hostData.sessionCode,
        hostAddress: hostData.listenAddresses[0],
        email: "peer@example.com",
      },
    });

    // --- Step 3: Host checks admissions and admits the peer ---
    // Wait for the admission request to arrive
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (hostState!.pendingAdmissions.size > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    const admissionsResult = await hostClient!.callTool({
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

    await hostClient!.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: peerPeerId },
    });

    // Now the join completes
    const joinResult = await joinPromise;
    const peerData = parseJson(joinResult) as {
      localPeerId: string;
      hostPeerId: string;
      authenticated: boolean;
      admitted: boolean;
    };
    expect(peerData.admitted).toBe(true);
    expect(peerData.hostPeerId).toBe(hostData.peerId);
    expect(peerState!.role).toBe("peer");

    // Verify both sides see consistent state
    const hostStatus = parseJson(
      await hostClient!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { role: string; peerCount: number; connectedPeers: string[] };
    expect(hostStatus.role).toBe("host");
    expect(hostStatus.peerCount).toBe(1);
    expect(hostStatus.connectedPeers).toContain(peerData.localPeerId);

    const peerStatus = parseJson(
      await peerClient!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { role: string; hostPeerId: string };
    expect(peerStatus.role).toBe("peer");
    expect(peerStatus.hostPeerId).toBe(hostData.peerId);

    // --- Step 4: Host edits a file → peer receives via hoop_check_updates ---
    const hostFileChange = await hostClient!.callTool({
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

    // Wait for broadcast to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Peer drains pending updates (simulates PreToolUse hook calling hoop_check_updates)
    const peerUpdates = parseJson(
      await peerClient!.callTool({ name: "hoop_check_updates", arguments: {} }),
    ) as { count: number; updates: Array<{ type: string; filePath: string; patch: string }> };
    expect(peerUpdates.count).toBeGreaterThanOrEqual(1);

    const fileChangeFromHost = peerUpdates.updates.find(
      (u) => u.type === "file-change" && u.filePath === "src/moduleA.ts",
    );
    expect(fileChangeFromHost).toBeDefined();
    expect(fileChangeFromHost!.patch).toBe(VALID_PATCH_A);

    // --- Step 5: Peer edits a different file → host receives ---
    const peerFileChange = await peerClient!.callTool({
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

    // Wait for broadcast to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Host drains pending updates
    const hostUpdates = parseJson(
      await hostClient!.callTool({ name: "hoop_check_updates", arguments: {} }),
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
      await hostClient!.callTool({ name: "hoop_check_updates", arguments: {} }),
    ) as { count: number };
    expect(hostUpdates2.count).toBe(0);

    // --- Step 6: Peer leaves gracefully ---
    const peerLeave = parseJson(
      await peerClient!.callTool({ name: "hoop_leave_session", arguments: {} }),
    ) as { left: boolean; previousRole: string };
    expect(peerLeave.left).toBe(true);
    expect(peerLeave.previousRole).toBe("peer");
    expect(peerState!.role).toBeNull();

    // --- Step 7: Host leaves gracefully ---
    const hostLeave = parseJson(
      await hostClient!.callTool({ name: "hoop_leave_session", arguments: {} }),
    ) as { left: boolean; previousRole: string };
    expect(hostLeave.left).toBe(true);
    expect(hostLeave.previousRole).toBe("host");
    expect(hostState!.role).toBeNull();
  }, 60_000);

  // ── Conflict detection across instances ──────────────────────────

  it("peer detects conflict when host is editing the same file", async () => {
    ({ server: hostServer, state: hostState, client: hostClient } = await createMcpInstance(hostDeps));
    ({ server: peerServer, state: peerState, client: peerClient } = await createMcpInstance(peerDeps));

    const createResult = await hostClient!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const hostData = parseJson(createResult) as { sessionCode: string; listenAddresses: string[] };

    const joinPromise = peerClient!.callTool({
      name: "hoop_join_session",
      arguments: {
        sessionCode: hostData.sessionCode,
        hostAddress: hostData.listenAddresses[0],
        email: "peer@example.com",
      },
    });

    // Admit
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (hostState!.pendingAdmissions.size > 0) { clearInterval(interval); resolve(); }
      }, 50);
    });

    const admissions = parseJson(
      await hostClient!.callTool({ name: "hoop_check_admissions", arguments: {} }),
    ) as { requests: Array<{ peerId: string }> };
    await hostClient!.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: admissions.requests[0].peerId },
    });
    await joinPromise;

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Host sends a file-change on src/shared.ts
    await hostClient!.callTool({
      name: "hoop_send_update",
      arguments: {
        type: "file-change",
        filePath: "src/shared.ts",
        patch: VALID_PATCH_A,
        baseHash: hashContent("original"),
        resultHash: hashContent("modified"),
      },
    });

    // Wait for broadcast to propagate
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Peer checks for conflict on the same file (simulates PreToolUse conflict hook)
    const conflictResult = parseJson(
      await peerClient!.callTool({
        name: "hoop_check_conflicts",
        arguments: { filePath: "src/shared.ts" },
      }),
    ) as { hasConflict: boolean; conflict: { peerId: string; type: string } | null };

    expect(conflictResult.hasConflict).toBe(true);
    expect(conflictResult.conflict).not.toBeNull();
  }, 60_000);

  // ── No orphaned processes after both leave ───────────────────────

  it("no active state remains after both instances leave", async () => {
    ({ server: hostServer, state: hostState, client: hostClient } = await createMcpInstance(hostDeps));
    ({ server: peerServer, state: peerState, client: peerClient } = await createMcpInstance(peerDeps));

    const createResult = await hostClient!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const hostData = parseJson(createResult) as { sessionCode: string; listenAddresses: string[] };

    const joinPromise = peerClient!.callTool({
      name: "hoop_join_session",
      arguments: {
        sessionCode: hostData.sessionCode,
        hostAddress: hostData.listenAddresses[0],
        email: "peer@example.com",
      },
    });

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (hostState!.pendingAdmissions.size > 0) { clearInterval(interval); resolve(); }
      }, 50);
    });

    const admissions = parseJson(
      await hostClient!.callTool({ name: "hoop_check_admissions", arguments: {} }),
    ) as { requests: Array<{ peerId: string }> };
    await hostClient!.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: admissions.requests[0].peerId },
    });
    await joinPromise;

    // Both leave
    await peerClient!.callTool({ name: "hoop_leave_session", arguments: {} });
    await hostClient!.callTool({ name: "hoop_leave_session", arguments: {} });

    // Verify all state is cleaned up
    expect(hostState!.role).toBeNull();
    expect(hostState!.hostSession).toBeNull();
    expect(hostState!.pendingUpdates).toHaveLength(0);
    expect(hostState!.pendingAdmissions.size).toBe(0);
    expect(hostState!.activeEditsTracker).toBeNull();
    expect(hostState!.pendingUpdatesWriter).toBeNull();
    expect(hostState!.outboundUpdatesReader).toBeNull();

    expect(peerState!.role).toBeNull();
    expect(peerState!.peerSession).toBeNull();
    expect(peerState!.pendingUpdates).toHaveLength(0);
    expect(peerState!.activeEditsTracker).toBeNull();
    expect(peerState!.pendingUpdatesWriter).toBeNull();
    expect(peerState!.outboundUpdatesReader).toBeNull();

    // Both report inactive status
    const hostStatus = parseJson(
      await hostClient!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { active: boolean };
    expect(hostStatus.active).toBe(false);

    const peerStatus = parseJson(
      await peerClient!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { active: boolean };
    expect(peerStatus.active).toBe(false);
  }, 60_000);

  // ── Bidirectional update exchange ────────────────────────────────

  it("both instances exchange multiple updates bidirectionally", async () => {
    ({ server: hostServer, state: hostState, client: hostClient } = await createMcpInstance(hostDeps));
    ({ server: peerServer, state: peerState, client: peerClient } = await createMcpInstance(peerDeps));

    const createResult = await hostClient!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const hostData = parseJson(createResult) as { sessionCode: string; listenAddresses: string[] };

    const joinPromise = peerClient!.callTool({
      name: "hoop_join_session",
      arguments: {
        sessionCode: hostData.sessionCode,
        hostAddress: hostData.listenAddresses[0],
        email: "peer@example.com",
      },
    });

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (hostState!.pendingAdmissions.size > 0) { clearInterval(interval); resolve(); }
      }, 50);
    });

    const admissions = parseJson(
      await hostClient!.callTool({ name: "hoop_check_admissions", arguments: {} }),
    ) as { requests: Array<{ peerId: string }> };
    await hostClient!.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: admissions.requests[0].peerId },
    });
    await joinPromise;

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Host sends 3 cursor updates
    for (let i = 0; i < 3; i++) {
      await hostClient!.callTool({
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
      await peerClient!.callTool({
        name: "hoop_send_update",
        arguments: {
          type: "metadata-update",
          key: `peer-key-${i}`,
          value: `peer-value-${i}`,
        },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Peer should have received all 3 host cursor updates
    const peerUpdates = parseJson(
      await peerClient!.callTool({ name: "hoop_check_updates", arguments: {} }),
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
      await hostClient!.callTool({ name: "hoop_check_updates", arguments: {} }),
    ) as { count: number; updates: Array<{ type: string; key?: string }> };

    const metaUpdates = hostUpdates.updates.filter((u) => u.type === "metadata-update");
    expect(metaUpdates).toHaveLength(2);
    expect(metaUpdates.map((u) => u.key).sort()).toEqual(["peer-key-0", "peer-key-1"]);
  }, 60_000);

  // ── Peer leave while host continues ──────────────────────────────

  it("host continues operating after peer disconnects", async () => {
    ({ server: hostServer, state: hostState, client: hostClient } = await createMcpInstance(hostDeps));
    ({ server: peerServer, state: peerState, client: peerClient } = await createMcpInstance(peerDeps));

    const createResult = await hostClient!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const hostData = parseJson(createResult) as { sessionCode: string; listenAddresses: string[] };

    const joinPromise = peerClient!.callTool({
      name: "hoop_join_session",
      arguments: {
        sessionCode: hostData.sessionCode,
        hostAddress: hostData.listenAddresses[0],
        email: "peer@example.com",
      },
    });

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (hostState!.pendingAdmissions.size > 0) { clearInterval(interval); resolve(); }
      }, 50);
    });

    const admissions = parseJson(
      await hostClient!.callTool({ name: "hoop_check_admissions", arguments: {} }),
    ) as { requests: Array<{ peerId: string }> };
    await hostClient!.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: admissions.requests[0].peerId },
    });
    await joinPromise;

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Peer leaves
    await peerClient!.callTool({ name: "hoop_leave_session", arguments: {} });

    // Wait for disconnect to propagate
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Host is still active and can send updates
    const hostStatus = parseJson(
      await hostClient!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { active: boolean; role: string; peerCount: number };
    expect(hostStatus.active).toBe(true);
    expect(hostStatus.role).toBe("host");
    expect(hostStatus.peerCount).toBe(0);

    // Host can still send updates (to replay buffer for future peers)
    const sendResult = parseJson(
      await hostClient!.callTool({
        name: "hoop_send_update",
        arguments: {
          type: "metadata-update",
          key: "still-alive",
          value: true,
        },
      }),
    ) as { accepted: boolean };
    expect(sendResult.accepted).toBe(true);
  }, 60_000);
});
