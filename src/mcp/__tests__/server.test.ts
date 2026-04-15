import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHoopMcpServer, type HoopMcpDeps } from "../server.js";
import { stubGitOps } from "../../session/createSession.js";
import { stubJoinGitOps } from "../../session/joinSession.js";

const CONFLICT_REGISTRY = join(tmpdir(), "hoop-conflict-test.json");

const TEST_DEPS: HoopMcpDeps = {
  gitOps: stubGitOps,
  joinGitOps: stubJoinGitOps,
  conflictRegistryPath: CONFLICT_REGISTRY,
};

async function setup(deps = TEST_DEPS) {
  const { server, state } = createHoopMcpServer(deps);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);

  return { server, state, client };
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

function parseJson(result: CallToolResult): unknown {
  const text = (result.content as Array<{ type: string; text: string }>)[0]
    .text;
  return JSON.parse(text);
}

describe("hoop MCP server", () => {
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof createHoopMcpServer>>["server"] | undefined;
  let state: Awaited<ReturnType<typeof createHoopMcpServer>>["state"] | undefined;

  afterEach(async () => {
    // Clean up session if active
    if (state?.role !== null) {
      try {
        await client?.callTool({ name: "hoop_leave_session", arguments: {} });
      } catch { /* ignore */ }
    }
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
    state = undefined;
    try { unlinkSync(CONFLICT_REGISTRY); } catch { /* ignore */ }
  });

  it("registers all 10 tools", async () => {
    ({ server, state, client } = await setup());

    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "hoop_admit_peer",
      "hoop_check_admissions",
      "hoop_check_conflicts",
      "hoop_check_updates",
      "hoop_create_session",
      "hoop_deny_peer",
      "hoop_get_status",
      "hoop_join_session",
      "hoop_leave_session",
      "hoop_send_update",
    ]);
  });

  it("hoop_get_status returns inactive when no session", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_get_status",
      arguments: {},
    });
    expect(parseJson(result)).toEqual({ active: false });
  });

  it("hoop_create_session starts a host session and returns session code", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const data = parseJson(result) as Record<string, unknown>;
    expect(data.sessionCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(data.executionTarget).toBe("host-only");
    expect(data.passwordProtected).toBe(false);
    expect(data.peerId).toBeTruthy();
    expect(data.listenAddresses).toBeDefined();
    expect(data.branchName).toMatch(/^hoop\/session-/);
    expect(state!.role).toBe("host");
  }, 30_000);

  it("rejects creating a second session while one is active", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]
      .text;
    expect(text).toContain("already active");
  }, 30_000);

  it("hoop_get_status returns host details after create", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "proponent-side" },
    });

    const result = await client!.callTool({
      name: "hoop_get_status",
      arguments: {},
    });

    const data = parseJson(result) as Record<string, unknown>;
    expect(data.active).toBe(true);
    expect(data.role).toBe("host");
    expect(data.executionTarget).toBe("proponent-side");
    expect(data.peerCount).toBe(0);
  }, 30_000);

  it("hoop_check_updates returns empty when no updates pending", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_check_updates",
      arguments: {},
    });

    const data = parseJson(result) as { count: number; updates: unknown[] };
    expect(data.count).toBe(0);
    expect(data.updates).toEqual([]);
  }, 30_000);

  it("hoop_check_admissions returns empty when no requests pending", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_check_admissions",
      arguments: {},
    });

    const data = parseJson(result) as { count: number };
    expect(data.count).toBe(0);
  }, 30_000);

  it("hoop_check_admissions fails for non-host", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_check_admissions",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("hoop_admit_peer and hoop_deny_peer fail for non-host", async () => {
    ({ server, state, client } = await setup());

    const admit = await client!.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: "fake" },
    });
    expect(admit.isError).toBe(true);

    const deny = await client!.callTool({
      name: "hoop_deny_peer",
      arguments: { peerId: "fake" },
    });
    expect(deny.isError).toBe(true);
  });

  it("hoop_leave_session cleans up host state", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    expect(state!.role).toBe("host");

    const result = await client!.callTool({
      name: "hoop_leave_session",
      arguments: {},
    });

    const data = parseJson(result) as Record<string, unknown>;
    expect(data.left).toBe(true);
    expect(data.previousRole).toBe("host");
    expect(state!.role).toBeNull();
    expect(state!.hostSession).toBeNull();
    expect(state!.pendingUpdates).toHaveLength(0);
  }, 30_000);

  it("hoop_leave_session fails when no session active", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_leave_session",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("can create a new session after leaving", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    await client!.callTool({
      name: "hoop_leave_session",
      arguments: {},
    });

    const result = await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "proponent-side" },
    });

    const data = parseJson(result) as Record<string, unknown>;
    expect(data.sessionCode).toBeTruthy();
    expect(data.executionTarget).toBe("proponent-side");
    expect(state!.role).toBe("host");
  }, 30_000);

  it("hoop_send_update broadcasts from host", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_send_update",
      arguments: {
        type: "metadata-update",
        key: "test-key",
        value: "test-value",
      },
    });

    const data = parseJson(result) as { accepted: boolean; seqNo: number };
    expect(data.accepted).toBe(true);
    expect(data.seqNo).toBe(1);

    // Host's own updates should NOT appear in pendingUpdates
    expect(state!.pendingUpdates).toHaveLength(0);
  }, 30_000);

  it("admission flow: queue, check, admit", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Simulate an admission request arriving
    const admissionPromise = new Promise<boolean>((resolve) => {
      state!.pendingAdmissions.set("peer-123", {
        email: "test@example.com",
        peerId: "peer-123",
        resolve,
        requestedAt: Date.now(),
      });
    });

    // Check admissions shows the pending request
    const checkResult = await client!.callTool({
      name: "hoop_check_admissions",
      arguments: {},
    });
    const checkData = parseJson(checkResult) as {
      count: number;
      requests: Array<{ email: string; peerId: string }>;
    };
    expect(checkData.count).toBe(1);
    expect(checkData.requests[0].email).toBe("test@example.com");
    expect(checkData.requests[0].peerId).toBe("peer-123");

    // Admit the peer
    const admitResult = await client!.callTool({
      name: "hoop_admit_peer",
      arguments: { peerId: "peer-123" },
    });
    const admitData = parseJson(admitResult) as {
      admitted: boolean;
      peerId: string;
    };
    expect(admitData.admitted).toBe(true);
    expect(admitData.peerId).toBe("peer-123");

    // The admission promise should resolve to true
    expect(await admissionPromise).toBe(true);
    expect(state!.pendingAdmissions.size).toBe(0);
  }, 30_000);

  it("admission flow: deny", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const admissionPromise = new Promise<boolean>((resolve) => {
      state!.pendingAdmissions.set("peer-456", {
        email: "deny@example.com",
        peerId: "peer-456",
        resolve,
        requestedAt: Date.now(),
      });
    });

    const denyResult = await client!.callTool({
      name: "hoop_deny_peer",
      arguments: { peerId: "peer-456" },
    });
    const denyData = parseJson(denyResult) as {
      denied: boolean;
      peerId: string;
    };
    expect(denyData.denied).toBe(true);

    expect(await admissionPromise).toBe(false);
  }, 30_000);

  it("hoop_leave_session rejects pending admissions", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const admissionPromise = new Promise<boolean>((resolve) => {
      state!.pendingAdmissions.set("peer-789", {
        email: "leave@example.com",
        peerId: "peer-789",
        resolve,
        requestedAt: Date.now(),
      });
    });

    await client!.callTool({
      name: "hoop_leave_session",
      arguments: {},
    });

    // Pending admission should be rejected on leave
    expect(await admissionPromise).toBe(false);
  }, 30_000);

  it("hoop_check_updates drains the queue", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Simulate peer updates arriving via the accumulator interceptor
    state!.pendingUpdates.push(
      {
        type: "cursor-update",
        peerId: "remote-peer",
        filePath: "src/index.ts",
        line: 10,
        column: 5,
        timestamp: Date.now(),
      },
      {
        type: "metadata-update",
        peerId: "remote-peer",
        key: "status",
        value: "editing",
        timestamp: Date.now(),
      },
    );

    // First drain returns all updates
    const result1 = await client!.callTool({
      name: "hoop_check_updates",
      arguments: {},
    });
    const data1 = parseJson(result1) as { count: number; updates: unknown[] };
    expect(data1.count).toBe(2);
    expect(data1.updates).toHaveLength(2);

    // Second drain returns empty
    const result2 = await client!.callTool({
      name: "hoop_check_updates",
      arguments: {},
    });
    const data2 = parseJson(result2) as { count: number; updates: unknown[] };
    expect(data2.count).toBe(0);
  }, 30_000);

  it("hoop_check_conflicts returns no conflict when no session", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_check_conflicts",
      arguments: { filePath: "src/main.ts" },
    });

    const data = parseJson(result) as { hasConflict: boolean };
    expect(data.hasConflict).toBe(false);
  });

  it("hoop_check_conflicts detects peer edit via accumulator", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Simulate a peer's dirty buffer arriving through the accumulator interceptor
    const hostSession = state!.hostSession!;
    hostSession.accumulator.accumulate({
      type: "buffer-update",
      peerId: "peer-alice",
      filePath: "src/main.ts",
      contentHash: "abc",
      version: 1,
      dirty: true,
      timestamp: Date.now(),
    });

    const result = await client!.callTool({
      name: "hoop_check_conflicts",
      arguments: { filePath: "src/main.ts" },
    });

    const data = parseJson(result) as {
      hasConflict: boolean;
      conflict: { peerId: string; type: string };
    };
    expect(data.hasConflict).toBe(true);
    expect(data.conflict.peerId).toBe("peer-alice");
    expect(data.conflict.type).toBe("dirty-buffer");
  }, 30_000);

  it("hoop_check_conflicts ignores host's own edits", async () => {
    ({ server, state, client } = await setup());

    const createResult = await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const hostPeerId = (parseJson(createResult) as { peerId: string }).peerId;

    // Host's own buffer update should NOT be tracked as a conflict
    state!.hostSession!.accumulator.accumulate({
      type: "buffer-update",
      peerId: hostPeerId,
      filePath: "src/main.ts",
      contentHash: "abc",
      version: 1,
      dirty: true,
      timestamp: Date.now(),
    });

    const result = await client!.callTool({
      name: "hoop_check_conflicts",
      arguments: { filePath: "src/main.ts" },
    });

    const data = parseJson(result) as { hasConflict: boolean };
    expect(data.hasConflict).toBe(false);
  }, 30_000);

  it("hoop_check_conflicts clears on leave", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    state!.hostSession!.accumulator.accumulate({
      type: "buffer-update",
      peerId: "peer-alice",
      filePath: "src/main.ts",
      contentHash: "abc",
      version: 1,
      dirty: true,
      timestamp: Date.now(),
    });

    await client!.callTool({
      name: "hoop_leave_session",
      arguments: {},
    });

    // After leaving, no conflicts should be reported
    const result = await client!.callTool({
      name: "hoop_check_conflicts",
      arguments: { filePath: "src/main.ts" },
    });

    const data = parseJson(result) as { hasConflict: boolean };
    expect(data.hasConflict).toBe(false);
  }, 30_000);
});
