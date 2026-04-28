import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { unlinkSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHoopMcpServer, type HoopMcpDeps } from "../server.js";
import { stubGitOps } from "../../session/createSession.js";
import { stubJoinGitOps } from "../../session/joinSession.js";
import { PendingUpdatesWriter } from "../../state/pendingUpdatesWriter.js";
import { PendingPromptRequestsWriter } from "../../state/pendingPromptRequestsWriter.js";
import { GOVERNANCE_CONFIG_KEY } from "../../session/session.js";

// Force tool mode so the create-session and set-settings tools honor the
// arguments passed by the test client. In elicit mode (the default for
// interactive REPL use) the server ignores caller args and elicits the
// values from the user via a form — that's the intended UX guarantee but
// would hang these tests since there's no UI to answer the form.
process.env.HOOP_ADMISSION_MODE = "tool";

const CONFLICT_REGISTRY = join(tmpdir(), "hoop-conflict-test.json");
const PENDING_UPDATES_REGISTRY = join(tmpdir(), "hoop-pending-updates-test.json");
const PENDING_ADMISSIONS_REGISTRY = join(tmpdir(), "hoop-pending-admissions-test.json");
const PENDING_PROMPT_REQUESTS_REGISTRY = join(tmpdir(), "hoop-pending-prompt-requests-test.json");
const SESSION_STATUS_FILE = join(tmpdir(), "hoop-session-status-test.json");

const TEST_DEPS: HoopMcpDeps = {
  gitOps: stubGitOps,
  joinGitOps: stubJoinGitOps,
  conflictRegistryPath: CONFLICT_REGISTRY,
  pendingUpdatesRegistryPath: PENDING_UPDATES_REGISTRY,
  pendingAdmissionsRegistryPath: PENDING_ADMISSIONS_REGISTRY,
  pendingPromptRequestsRegistryPath: PENDING_PROMPT_REQUESTS_REGISTRY,
  sessionStatusPath: SESSION_STATUS_FILE,
};

async function setup(deps = TEST_DEPS) {
  const { server, state, revalidateGovernanceThreshold } = createHoopMcpServer(deps);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);

  return { server, state, client, revalidateGovernanceThreshold };
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
  let revalidateGovernanceThreshold: Awaited<ReturnType<typeof createHoopMcpServer>>["revalidateGovernanceThreshold"] | undefined;

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
    try { unlinkSync(PENDING_UPDATES_REGISTRY); } catch { /* ignore */ }
    try { unlinkSync(PENDING_ADMISSIONS_REGISTRY); } catch { /* ignore */ }
    try { unlinkSync(PENDING_PROMPT_REQUESTS_REGISTRY); } catch { /* ignore */ }
    try { unlinkSync(SESSION_STATUS_FILE); } catch { /* ignore */ }
  });

  it("registers all 25 tools", async () => {
    ({ server, state, client } = await setup());

    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "hoop_acquire_lock",
      "hoop_admit_peer",
      "hoop_approve_patches",
      "hoop_approve_prompt_request",
      "hoop_check_admissions",
      "hoop_check_conflicts",
      "hoop_check_patch_reviews",
      "hoop_check_prompt_requests",
      "hoop_check_updates",
      "hoop_complete_prompt_request",
      "hoop_create_session",
      "hoop_deny_peer",
      "hoop_deny_prompt_request",
      "hoop_force_unlock",
      "hoop_get_status",
      "hoop_join_session",
      "hoop_leave_session",
      "hoop_lock_status",
      "hoop_poll_execution_result",
      "hoop_poll_patch_status",
      "hoop_reject_patches",
      "hoop_release_lock",
      "hoop_request_host_execution",
      "hoop_send_update",
      "hoop_set_settings",
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

  it("hoop_lock_status returns a free lock when no session is active", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_lock_status",
      arguments: {},
    });

    expect(parseJson(result)).toEqual({
      holderPeerId: null,
      acquiredAt: null,
      status: "free",
    });
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

  it("host can acquire, inspect, and release the lock", async () => {
    ({ server, state, client } = await setup());

    const createResult = await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const hostPeerId = (parseJson(createResult) as { peerId: string }).peerId;

    const acquireResult = await client!.callTool({
      name: "hoop_acquire_lock",
      arguments: {},
    });
    expect(parseJson(acquireResult)).toEqual({
      acquired: true,
      holder: hostPeerId,
    });

    const statusResult = await client!.callTool({
      name: "hoop_lock_status",
      arguments: {},
    });
    expect(parseJson(statusResult)).toEqual({
      holderPeerId: hostPeerId,
      acquiredAt: expect.any(Number),
      status: "busy",
    });

    const releaseResult = await client!.callTool({
      name: "hoop_release_lock",
      arguments: {},
    });
    expect(parseJson(releaseResult)).toEqual({ released: true, holder: null });
  }, 30_000);

  it("hoop_force_unlock fails with no active session", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_force_unlock",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: "No active session." }),
    ]);
  }, 30_000);

  it("hoop_force_unlock rejects when called by a peer", async () => {
    ({ server, state, client } = await setup());

    // Simulate being a peer (not a host)
    state!.role = "peer";

    const result = await client!.callTool({
      name: "hoop_force_unlock",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: "Only the host can force-unlock." }),
    ]);
  }, 30_000);

  it("hoop_force_unlock returns released:false when lock is already free", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_force_unlock",
      arguments: {},
    });

    expect(parseJson(result)).toEqual({ released: false, holder: null });
  }, 30_000);

  it("hoop_force_unlock releases a peer's lock", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Simulate a peer acquiring the lock directly on the host session
    state!.hostSession!.acquireLock("fake-peer-id");

    const statusBefore = await client!.callTool({
      name: "hoop_lock_status",
      arguments: {},
    });
    expect(parseJson(statusBefore)).toEqual({
      holderPeerId: "fake-peer-id",
      acquiredAt: expect.any(Number),
      status: "busy",
    });

    const result = await client!.callTool({
      name: "hoop_force_unlock",
      arguments: {},
    });
    expect(parseJson(result)).toEqual({ released: true, holder: null });

    const statusAfter = await client!.callTool({
      name: "hoop_lock_status",
      arguments: {},
    });
    expect(parseJson(statusAfter)).toEqual({
      holderPeerId: null,
      acquiredAt: null,
      status: "free",
    });
  }, 30_000);

  it("hoop_force_unlock can release the host's own lock", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_acquire_lock",
      arguments: {},
    });

    const result = await client!.callTool({
      name: "hoop_force_unlock",
      arguments: {},
    });
    expect(parseJson(result)).toEqual({ released: true, holder: null });

    const statusAfter = await client!.callTool({
      name: "hoop_lock_status",
      arguments: {},
    });
    expect(parseJson(statusAfter)).toEqual({
      holderPeerId: null,
      acquiredAt: null,
      status: "free",
    });
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

  it("hoop_check_admissions mirrors pending requests to the hook registry", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    state!.pendingAdmissions.set("peer-123", {
      email: "test@example.com",
      peerId: "peer-123",
      resolve: () => {},
      requestedAt: 123,
    });

    await client!.callTool({
      name: "hoop_check_admissions",
      arguments: {},
    });

    const registry = JSON.parse(
      readFileSync(PENDING_ADMISSIONS_REGISTRY, "utf-8"),
    ) as {
      requests: Array<{ email: string; peerId: string; requestedAt: number }>;
    };

    expect(registry.requests).toEqual([
      {
        email: "test@example.com",
        peerId: "peer-123",
        requestedAt: 123,
      },
    ]);
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

  it("hoop_check_conflicts detects peer edit via published update", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Simulate a peer's dirty buffer arriving through the unified publish path
    const hostSession = state!.hostSession!;
    hostSession.publishUpdate({
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
    state!.hostSession!.publishUpdate({
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

    state!.hostSession!.publishUpdate({
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

  it("pending updates writer tracks peer file changes via published update", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Simulate a peer file-change arriving through the unified publish path
    state!.hostSession!.publishUpdate({
      type: "file-change",
      peerId: "peer-alice",
      filePath: "src/main.ts",
      patch: "@@ -1,3 +1,4 @@\n+new line",
      baseHash: "aaa",
      resultHash: "bbb",
      timestamp: Date.now(),
    });

    // Allow async write queue to process
    await new Promise(resolve => setImmediate(resolve));

    const registry = PendingUpdatesWriter.readRegistry(PENDING_UPDATES_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.updates).toHaveLength(1);
    expect(registry!.updates[0].peerId).toBe("peer-alice");
    expect(registry!.updates[0].filePath).toBe("src/main.ts");
    expect(registry!.updates[0].patch).toContain("+new line");
  }, 30_000);

  it("pending updates writer ignores host's own file changes", async () => {
    ({ server, state, client } = await setup());

    const createResult = await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const hostPeerId = (parseJson(createResult) as { peerId: string }).peerId;

    // Host's own file-change should NOT be written to registry
    state!.hostSession!.publishUpdate({
      type: "file-change",
      peerId: hostPeerId,
      filePath: "src/main.ts",
      patch: "+self change",
      baseHash: "aaa",
      resultHash: "bbb",
      timestamp: Date.now(),
    });

    const registry = PendingUpdatesWriter.readRegistry(PENDING_UPDATES_REGISTRY);
    expect(registry).toBeNull();
  }, 30_000);

  it("pending updates writer clears on leave", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    state!.hostSession!.publishUpdate({
      type: "file-change",
      peerId: "peer-alice",
      filePath: "src/main.ts",
      patch: "+change",
      baseHash: "aaa",
      resultHash: "bbb",
      timestamp: Date.now(),
    });

    await client!.callTool({
      name: "hoop_leave_session",
      arguments: {},
    });

    const registry = PendingUpdatesWriter.readRegistry(PENDING_UPDATES_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.updates).toHaveLength(0);
  }, 30_000);

  it("hoop_create_session writes session status file", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    expect(existsSync(SESSION_STATUS_FILE)).toBe(true);
    const status = JSON.parse(readFileSync(SESSION_STATUS_FILE, "utf-8"));
    expect(status.active).toBe(true);
    expect(status.role).toBe("host");
    expect(status.sessionCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(status.branchName).toMatch(/^hoop\/session-/);
    expect(status.executionTarget).toBe("host-only");
    expect(status.pid).toBe(process.pid);
    expect(status.startedAt).toBeGreaterThan(0);
  }, 30_000);

  it("hoop_leave_session clears session status file", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    expect(existsSync(SESSION_STATUS_FILE)).toBe(true);

    await client!.callTool({
      name: "hoop_leave_session",
      arguments: {},
    });
    expect(existsSync(SESSION_STATUS_FILE)).toBe(false);
  }, 30_000);

  it("gracefulShutdown clears session status file when no active session", async () => {
    const { gracefulShutdown } = createHoopMcpServer(TEST_DEPS);
    // No session active — gracefulShutdown should not throw
    await gracefulShutdown();
    expect(existsSync(SESSION_STATUS_FILE)).toBe(false);
  });

  // ── Prompt execution tools ─────────────────────────────────────────

  it("hoop_check_prompt_requests returns empty when no requests pending", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_check_prompt_requests",
      arguments: {},
    });

    const data = parseJson(result) as { count: number; requests: unknown[] };
    expect(data.count).toBe(0);
    expect(data.requests).toEqual([]);
  }, 30_000);

  it("hoop_check_prompt_requests fails for non-host", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_check_prompt_requests",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("hoop_approve_prompt_request fails for non-host", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_approve_prompt_request",
      arguments: { requestId: "fake" },
    });
    expect(result.isError).toBe(true);
  });

  it("hoop_deny_prompt_request fails for non-host", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_deny_prompt_request",
      arguments: { requestId: "fake" },
    });
    expect(result.isError).toBe(true);
  });

  it("hoop_complete_prompt_request fails for non-host", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_complete_prompt_request",
      arguments: { requestId: "fake" },
    });
    expect(result.isError).toBe(true);
  });

  it("hoop_request_host_execution fails for non-peer", async () => {
    ({ server, state, client } = await setup());

    // No session
    const result1 = await client!.callTool({
      name: "hoop_request_host_execution",
      arguments: { prompt: "test" },
    });
    expect(result1.isError).toBe(true);

    // Host session
    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result2 = await client!.callTool({
      name: "hoop_request_host_execution",
      arguments: { prompt: "test" },
    });
    expect(result2.isError).toBe(true);
  }, 30_000);

  it("hoop_poll_execution_result fails for non-peer", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_poll_execution_result",
      arguments: { requestId: "fake" },
    });
    expect(result.isError).toBe(true);
  });

  it("prompt request flow: enqueue, check, approve, complete", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Simulate a prompt request arriving via the protocol handler
    const queue = state!.hostSession!.promptRequestQueue;
    queue.enqueue(
      {
        id: "req-1",
        prompt: "Fix the auth bug",
        requestedBy: "peer-abc",
        timestamp: Date.now(),
      },
      false,
    );

    // Check shows the pending request
    const checkResult = await client!.callTool({
      name: "hoop_check_prompt_requests",
      arguments: {},
    });
    const checkData = parseJson(checkResult) as {
      count: number;
      requests: Array<{ id: string; prompt: string; status: string }>;
    };
    expect(checkData.count).toBe(1);
    expect(checkData.requests[0].id).toBe("req-1");
    expect(checkData.requests[0].prompt).toBe("Fix the auth bug");
    expect(checkData.requests[0].status).toBe("pending-approval");

    // Approve
    const approveResult = await client!.callTool({
      name: "hoop_approve_prompt_request",
      arguments: { requestId: "req-1" },
    });
    const approveData = parseJson(approveResult) as { id: string; status: string };
    expect(approveData.status).toBe("approved");

    // Complete
    const completeResult = await client!.callTool({
      name: "hoop_complete_prompt_request",
      arguments: { requestId: "req-1" },
    });
    const completeData = parseJson(completeResult) as { id: string; status: string };
    expect(completeData.status).toBe("completed");

    // Queue is now empty
    const checkResult2 = await client!.callTool({
      name: "hoop_check_prompt_requests",
      arguments: {},
    });
    expect((parseJson(checkResult2) as { count: number }).count).toBe(0);
  }, 30_000);

  it("prompt request flow: enqueue and deny", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const queue = state!.hostSession!.promptRequestQueue;
    queue.enqueue(
      {
        id: "req-2",
        prompt: "Dangerous operation",
        requestedBy: "peer-xyz",
        timestamp: Date.now(),
      },
      false,
    );

    const denyResult = await client!.callTool({
      name: "hoop_deny_prompt_request",
      arguments: { requestId: "req-2", reason: "Too risky" },
    });
    const denyData = parseJson(denyResult) as { id: string; status: string; reason: string };
    expect(denyData.status).toBe("denied");
    expect(denyData.reason).toBe("Too risky");

    // Denied entry stays in queue but not in active list
    expect(queue.get("req-2")?.status).toBe("denied");
    expect(queue.listActive()).toHaveLength(0);
  }, 30_000);

  it("prompt request flow: complete with error marks as failed", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const queue = state!.hostSession!.promptRequestQueue;
    queue.enqueue(
      {
        id: "req-3",
        prompt: "Task that fails",
        requestedBy: "peer-fail",
        timestamp: Date.now(),
      },
      true, // auto-approved
    );

    const result = await client!.callTool({
      name: "hoop_complete_prompt_request",
      arguments: { requestId: "req-3", error: "Compilation failed" },
    });
    const data = parseJson(result) as { id: string; status: string; error: string };
    expect(data.status).toBe("failed");
    expect(data.error).toBe("Compilation failed");
  }, 30_000);

  it("hoop_approve_prompt_request fails for unknown request", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_approve_prompt_request",
      arguments: { requestId: "nonexistent" },
    });
    expect(result.isError).toBe(true);
  }, 30_000);

  it("hoop_deny_prompt_request fails for unknown request", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_deny_prompt_request",
      arguments: { requestId: "nonexistent" },
    });
    expect(result.isError).toBe(true);
  }, 30_000);

  it("hoop_complete_prompt_request fails for unknown request", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_complete_prompt_request",
      arguments: { requestId: "nonexistent" },
    });
    expect(result.isError).toBe(true);
  }, 30_000);

  it("autoExecutePrompts flag is returned in create and status", async () => {
    ({ server, state, client } = await setup());

    const createResult = await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only", autoExecutePrompts: true },
    });
    const createData = parseJson(createResult) as { autoExecutePrompts: boolean };
    expect(createData.autoExecutePrompts).toBe(true);

    const statusResult = await client!.callTool({
      name: "hoop_get_status",
      arguments: {},
    });
    const statusData = parseJson(statusResult) as { autoExecutePrompts: boolean };
    expect(statusData.autoExecutePrompts).toBe(true);
  }, 30_000);

  it("autoExecutePrompts defaults to false", async () => {
    ({ server, state, client } = await setup());

    const createResult = await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });
    const createData = parseJson(createResult) as { autoExecutePrompts: boolean };
    expect(createData.autoExecutePrompts).toBe(false);

    expect(state!.hostSession!.autoExecutePrompts).toBe(false);
  }, 30_000);

  it("hoop_check_prompt_requests mirrors pending requests to hook registry", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const queue = state!.hostSession!.promptRequestQueue;
    queue.enqueue(
      {
        id: "req-hook",
        prompt: "Hook test",
        model: "sonnet",
        requestedBy: "peer-hook",
        timestamp: 1000,
      },
      false,
    );

    await client!.callTool({
      name: "hoop_check_prompt_requests",
      arguments: {},
    });

    const registry = PendingPromptRequestsWriter.readRegistry(
      PENDING_PROMPT_REQUESTS_REGISTRY,
    );
    expect(registry).not.toBeNull();
    expect(registry!.requests).toHaveLength(1);
    expect(registry!.requests[0].id).toBe("req-hook");
    expect(registry!.requests[0].prompt).toBe("Hook test");
    expect(registry!.requests[0].model).toBe("sonnet");
    expect(registry!.requests[0].requestedBy).toBe("peer-hook");
    expect(registry!.requests[0].status).toBe("pending-approval");
  }, 30_000);

  it("hoop_leave_session clears prompt request state", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    state!.hostSession!.promptRequestQueue.enqueue(
      {
        id: "req-leave",
        prompt: "Will be cleared",
        requestedBy: "peer-leave",
        timestamp: Date.now(),
      },
      false,
    );

    await client!.callTool({
      name: "hoop_leave_session",
      arguments: {},
    });

    expect(state!.pendingPromptRequestsWriter).toBeNull();
    expect(state!.peerPromptRequests.size).toBe(0);
  }, 30_000);

  it("hoop_get_status includes activePromptRequests count for host", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // No active requests initially
    const status1 = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { activePromptRequests: number };
    expect(status1.activePromptRequests).toBe(0);

    // Add a pending request
    state!.hostSession!.promptRequestQueue.enqueue(
      {
        id: "req-count",
        prompt: "Count me",
        requestedBy: "peer-count",
        timestamp: Date.now(),
      },
      false,
    );

    const status2 = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { activePromptRequests: number };
    expect(status2.activePromptRequests).toBe(1);
  }, 30_000);

  // ── hoop_set_settings ──────────────────────────────────────────────

  it("hoop_set_settings rejects when no session is active", async () => {
    ({ server, state, client } = await setup());

    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "yolo" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Only the host");
  });

  it("hoop_set_settings sets mode and returns accepted with seqNo", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "yolo" },
    });

    const data = parseJson(result) as { accepted: boolean; governance: { mode: string }; seqNo: number };
    expect(data.accepted).toBe(true);
    expect(data.governance.mode).toBe("yolo");
    expect(typeof data.seqNo).toBe("number");
  }, 30_000);

  it("hoop_get_status defaults to captain governance mode", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const status = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { governance: { mode: string } };
    expect(status.governance.mode).toBe("captain");
  }, 30_000);

  it("hoop_get_status reflects governance mode after hoop_set_settings", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust" },
    });

    const status = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { governance: { mode: string } };
    expect(status.governance.mode).toBe("zero-trust");
  }, 30_000);

  it("hoop_set_settings publishes metadata update to accumulator", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "yolo" },
    });

    const metadata = state!.hostSession!.accumulator.getMetadata(GOVERNANCE_CONFIG_KEY);
    expect(metadata).toBeDefined();
    expect(metadata!.value).toEqual({ mode: "yolo" });
  }, 30_000);

  it("governance mode resets to captain after leaving and creating a new session", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "yolo" },
    });

    await client!.callTool({ name: "hoop_leave_session", arguments: {} });

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const status = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { governance: { mode: string } };
    expect(status.governance.mode).toBe("captain");
  }, 30_000);

  it("hoop_set_settings rejects when called by a peer", async () => {
    ({ server, state, client } = await setup());

    // Simulate a peer session by setting role directly
    state!.role = "peer";

    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "yolo" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Only the host");

    // Reset so afterEach cleanup doesn't try to leave a non-existent session
    state!.role = null;
  });

  it("hoop_set_settings returns unchanged when setting the same mode", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "yolo" },
    });

    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "yolo" },
    });

    const data = parseJson(result) as { accepted: boolean; governance: { mode: string }; seqNo: null; unchanged: boolean };
    expect(data.accepted).toBe(true);
    expect(data.governance.mode).toBe("yolo");
    expect(data.seqNo).toBeNull();
    expect(data.unchanged).toBe(true);
  }, 30_000);

  // ── Zero-trust threshold ──────────────────────────────────────────

  it("hoop_set_settings accepts majority threshold for zero-trust", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: "majority" },
    });

    const data = parseJson(result) as { accepted: boolean; governance: { mode: string; threshold: string }; seqNo: number };
    expect(data.accepted).toBe(true);
    expect(data.governance.mode).toBe("zero-trust");
    expect(data.governance.threshold).toBe("majority");
    expect(typeof data.seqNo).toBe("number");
  }, 30_000);

  it("hoop_set_settings accepts consensus threshold for zero-trust", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: "consensus" },
    });

    const data = parseJson(result) as { accepted: boolean; governance: { mode: string; threshold: string } };
    expect(data.accepted).toBe(true);
    expect(data.governance.mode).toBe("zero-trust");
    expect(data.governance.threshold).toBe("consensus");
  }, 30_000);

  it("hoop_set_settings accepts integer threshold for zero-trust when within party size", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // threshold=1 with party size=1 (host only) should be accepted as-is
    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 1 },
    });

    const data = parseJson(result) as { accepted: boolean; governance: { mode: string; threshold: number } };
    expect(data.accepted).toBe(true);
    expect(data.governance.mode).toBe("zero-trust");
    expect(data.governance.threshold).toBe(1);
  }, 30_000);

  it("hoop_set_settings defaults threshold to majority when switching to zero-trust without threshold", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust" },
    });

    const data = parseJson(result) as { accepted: boolean; governance: { mode: string; threshold: string } };
    expect(data.accepted).toBe(true);
    expect(data.governance.threshold).toBe("majority");
  }, 30_000);

  it("hoop_set_settings rejects threshold for non-zero-trust modes", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "yolo", threshold: "majority" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("only valid for zero-trust");
  }, 30_000);

  it("hoop_get_status includes threshold when mode is zero-trust", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: "consensus" },
    });

    const status = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { governance: { mode: string; threshold: string } };
    expect(status.governance.mode).toBe("zero-trust");
    expect(status.governance.threshold).toBe("consensus");
  }, 30_000);

  it("hoop_get_status omits threshold when mode is not zero-trust", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const status = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { governance: { mode: string } };
    expect(status.governance.mode).toBe("captain");
    expect(status.governance).not.toHaveProperty("threshold");
  }, 30_000);

  it("hoop_set_settings publishes threshold as metadata update", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // threshold=1 fits party size=1 (host only), so it applies as-is
    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 1 },
    });

    const configMeta = state!.hostSession!.accumulator.getMetadata(GOVERNANCE_CONFIG_KEY);
    expect(configMeta).toBeDefined();
    expect(configMeta!.value).toEqual({ mode: "zero-trust", threshold: 1 });
  }, 30_000);

  it("hoop_set_settings returns unchanged when mode and threshold are the same", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: "consensus" },
    });

    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: "consensus" },
    });

    const data = parseJson(result) as { accepted: boolean; unchanged: boolean; governance: { mode: string; threshold: string } };
    expect(data.accepted).toBe(true);
    expect(data.unchanged).toBe(true);
    expect(data.governance.threshold).toBe("consensus");
  }, 30_000);

  it("hoop_set_settings updates only threshold when mode stays zero-trust", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: "consensus" },
    });

    // threshold=1 fits party size=1, so it applies as-is
    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 1 },
    });

    const data = parseJson(result) as { accepted: boolean; governance: { mode: string; threshold: number }; seqNo: number };
    expect(data.accepted).toBe(true);
    expect(data.governance.mode).toBe("zero-trust");
    expect(data.governance.threshold).toBe(1);
    expect(typeof data.seqNo).toBe("number");

    const configMeta = state!.hostSession!.accumulator.getMetadata(GOVERNANCE_CONFIG_KEY);
    expect(configMeta!.value).toEqual({ mode: "zero-trust", threshold: 1 });
  }, 30_000);

  it("zero-trust threshold resets to default after leave and recreate", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 1 },
    });

    await client!.callTool({ name: "hoop_leave_session", arguments: {} });

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Switch to zero-trust to check the default threshold
    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust" },
    });

    const status = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { governance: { threshold: string } };
    expect(status.governance.threshold).toBe("majority");
  }, 30_000);

  // ── Threshold fallback (CRE-27) ───────────────────────────────────

  it("hoop_set_settings falls back to consensus when integer threshold exceeds party size", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // party size = 1 (host only), threshold 3 exceeds it
    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 3 },
    });

    const data = parseJson(result) as { accepted: boolean; governance: { mode: string; threshold: string }; warning: string };
    expect(data.accepted).toBe(true);
    expect(data.governance.mode).toBe("zero-trust");
    expect(data.governance.threshold).toBe("consensus");
    expect(data.warning).toContain("exceeds party size");
    expect(data.warning).toContain("consensus");
  }, 30_000);

  it("hoop_set_settings fallback warning suggests new threshold when party size > 2", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Simulate 2 connected peers (party size = 3)
    const hub = state!.hostSession!.broadcastHub;
    const mockStream = { send: () => {}, close: () => Promise.resolve() } as any;
    hub.subscribe("fake-peer-1", mockStream);
    hub.subscribe("fake-peer-2", mockStream);

    // threshold 5 exceeds party size 3
    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 5 },
    });

    const data = parseJson(result) as { accepted: boolean; governance: { mode: string; threshold: string }; warning: string };
    expect(data.accepted).toBe(true);
    expect(data.governance.threshold).toBe("consensus");
    expect(data.warning).toContain("up to 3");

    hub.unsubscribe("fake-peer-1");
    hub.unsubscribe("fake-peer-2");
  }, 30_000);

  it("hoop_set_settings fallback omits 'new threshold' suggestion when party size = 2", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Simulate 1 connected peer (party size = 2)
    const hub = state!.hostSession!.broadcastHub;
    const mockStream = { send: () => {}, close: () => Promise.resolve() } as any;
    hub.subscribe("fake-peer-1", mockStream);

    // threshold 3 exceeds party size 2
    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 3 },
    });

    const data = parseJson(result) as { warning: string };
    expect(data.warning).toContain("Falling back to consensus");
    expect(data.warning).not.toContain("up to");

    hub.unsubscribe("fake-peer-1");
  }, 30_000);

  it("hoop_set_settings clears governance alert on successful mode change", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Trigger fallback to set alert
    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 5 },
    });
    expect(state!.governanceAlert).not.toBeNull();

    // Set a valid mode — alert should clear
    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "yolo" },
    });
    expect(state!.governanceAlert).toBeNull();
  }, 30_000);

  it("hoop_get_status includes governanceAlert after threshold fallback", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 3 },
    });

    const status = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as { governanceAlert: string };
    expect(status.governanceAlert).toContain("exceeds party size");
  }, 30_000);

  it("hoop_get_status omits governanceAlert when no fallback occurred", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const status = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as Record<string, unknown>;
    expect(status).not.toHaveProperty("governanceAlert");
  }, 30_000);

  it("peer disconnect triggers governance fallback when threshold exceeds new party size", async () => {
    ({ server, state, client, revalidateGovernanceThreshold } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Add 2 peers (party size = 3), set threshold=3 which fits
    const hub = state!.hostSession!.broadcastHub;
    const mockStream = { send: () => {}, close: () => Promise.resolve() } as any;
    hub.subscribe("fake-peer-1", mockStream);
    hub.subscribe("fake-peer-2", mockStream);

    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 3 },
    });

    expect(state!.observedGovernanceConfig).toEqual({ mode: "zero-trust", threshold: 3 });

    // Simulate disconnect: remove peer from hub then drive the real revalidation
    hub.unsubscribe("fake-peer-1");
    revalidateGovernanceThreshold!();

    expect(state!.observedGovernanceConfig).toEqual({ mode: "zero-trust", threshold: "consensus" });
    expect(state!.governanceAlert).toContain("Peer disconnected");

    // Verify the fallback was also published to the accumulator
    const configMeta = state!.hostSession!.accumulator.getMetadata(GOVERNANCE_CONFIG_KEY);
    expect(configMeta!.value).toEqual({ mode: "zero-trust", threshold: "consensus" });

    hub.unsubscribe("fake-peer-2");
  }, 30_000);

  it("named thresholds are not affected by party size fallback", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // majority and consensus should work regardless of party size
    const result1 = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: "majority" },
    });
    const data1 = parseJson(result1) as { governance: { threshold: string }; warning?: string };
    expect(data1.governance.threshold).toBe("majority");
    expect(data1).not.toHaveProperty("warning");

    const result2 = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: "consensus" },
    });
    const data2 = parseJson(result2) as { governance: { threshold: string }; warning?: string };
    expect(data2.governance.threshold).toBe("consensus");
    expect(data2).not.toHaveProperty("warning");
  }, 30_000);

  it("governanceAlert does not leak into a new session after leave", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Trigger fallback to set alert
    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 5 },
    });
    expect(state!.governanceAlert).not.toBeNull();

    // Leave and create a fresh session
    await client!.callTool({ name: "hoop_leave_session", arguments: {} });
    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const status = parseJson(
      await client!.callTool({ name: "hoop_get_status", arguments: {} }),
    ) as Record<string, unknown>;
    expect(status).not.toHaveProperty("governanceAlert");
    expect(state!.governanceAlert).toBeNull();
  }, 30_000);

  it("idempotent hoop_set_settings clears stale governance alert", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Trigger fallback — threshold 3 exceeds party size 1 → falls back to consensus
    await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: 3 },
    });
    expect(state!.governanceAlert).not.toBeNull();
    expect(state!.observedGovernanceConfig).toEqual({ mode: "zero-trust", threshold: "consensus" });

    // Re-apply consensus explicitly — unchanged path should still clear the alert
    const result = await client!.callTool({
      name: "hoop_set_settings",
      arguments: { mode: "zero-trust", threshold: "consensus" },
    });
    const data = parseJson(result) as { unchanged: boolean };
    expect(data.unchanged).toBe(true);
    expect(state!.governanceAlert).toBeNull();
  }, 30_000);

  it("mirrorObservedUpdate ignores invalid governance config values", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Publish an invalid governance config — should be ignored
    state!.hostSession!.publishUpdate({
      type: "metadata-update",
      peerId: state!.hostSession!.peerId,
      key: GOVERNANCE_CONFIG_KEY,
      value: { mode: "invalid-mode" },
      timestamp: Date.now(),
    });

    // Should still be the default
    expect(state!.observedGovernanceConfig).toEqual({ mode: "captain" });
  }, 30_000);

  it("mirrorObservedUpdate applies governance config from published update", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Publish a governance config update through the host session.
    // The mirrorObservedUpdate callback should update observedGovernanceConfig.
    state!.hostSession!.publishUpdate({
      type: "metadata-update",
      peerId: state!.hostSession!.peerId,
      key: GOVERNANCE_CONFIG_KEY,
      value: { mode: "zero-trust", threshold: "consensus" },
      timestamp: Date.now(),
    });

    expect(state!.observedGovernanceConfig).toEqual({ mode: "zero-trust", threshold: "consensus" });
  }, 30_000);

  // ── Captain mode patch review tests ──────────────────────────────

  const VALID_PATCH = [
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,3 @@",
    " line1",
    "-line2",
    "+line2-modified",
    " line3",
  ].join("\n");

  function makeFileChange(peerId: string, filePath: string, baseHash: string, resultHash: string) {
    return {
      type: "file-change" as const,
      peerId,
      filePath,
      patch: VALID_PATCH,
      baseHash,
      resultHash,
      timestamp: Date.now(),
    };
  }

  it("captain mode: hoop_check_patch_reviews returns empty when no patches pending", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_check_patch_reviews",
      arguments: {},
    });
    const data = parseJson(result) as { reviews: unknown[] };
    expect(data.reviews).toEqual([]);
  }, 30_000);

  it("captain mode: hoop_check_patch_reviews rejects non-host", async () => {
    ({ server, state, client } = await setup());

    // No session active
    const result = await client!.callTool({
      name: "hoop_check_patch_reviews",
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/host/i);
    expect(result.isError).toBe(true);
  }, 30_000);

  it("captain mode: enqueue + approve broadcasts patches", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Default mode is captain — enqueue a file-change for a fake peer
    expect(state!.observedGovernanceConfig.mode).toBe("captain");
    const peerUpdate = makeFileChange("peer-A", "src/app.ts", "hash-0", "hash-1");
    const queue = state!.hostSession!.patchReviewQueue;
    const reviewId = queue.enqueue(peerUpdate, "peer-A");

    // Check reviews shows the pending batch
    const checkResult = await client!.callTool({
      name: "hoop_check_patch_reviews",
      arguments: {},
    });
    const checkData = parseJson(checkResult) as { reviews: Array<{ reviewId: string; peerId: string }> };
    expect(checkData.reviews).toHaveLength(1);
    expect(checkData.reviews[0].reviewId).toBe(reviewId);
    expect(checkData.reviews[0].peerId).toBe("peer-A");

    // Approve the patches
    const approveResult = await client!.callTool({
      name: "hoop_approve_patches",
      arguments: { peerId: "peer-A" },
    });
    const approveData = parseJson(approveResult) as { approved: boolean; fileCount: number; seqNos: number[] };
    expect(approveData.approved).toBe(true);
    expect(approveData.fileCount).toBe(1);
    expect(approveData.seqNos).toHaveLength(1);

    // Queue is now empty
    const checkResult2 = await client!.callTool({
      name: "hoop_check_patch_reviews",
      arguments: {},
    });
    const checkData2 = parseJson(checkResult2) as { reviews: unknown[] };
    expect(checkData2.reviews).toHaveLength(0);
  }, 30_000);

  it("captain mode: reject notifies with reason", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const peerUpdate = makeFileChange("peer-B", "src/lib.ts", "hash-0", "hash-1");
    const queue = state!.hostSession!.patchReviewQueue;
    queue.enqueue(peerUpdate, "peer-B");

    const rejectResult = await client!.callTool({
      name: "hoop_reject_patches",
      arguments: { peerId: "peer-B", reason: "code quality" },
    });
    const rejectData = parseJson(rejectResult) as { rejected: boolean; reason: string; fileCount: number };
    expect(rejectData.rejected).toBe(true);
    expect(rejectData.reason).toBe("code quality");
    expect(rejectData.fileCount).toBe(1);

    // Queue is now empty
    const pending = queue.listPending();
    expect(pending).toHaveLength(0);
  }, 30_000);

  it("captain mode: approve with unknown peerId returns error", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_approve_patches",
      arguments: { peerId: "nonexistent-peer" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/no pending/i);
  }, 30_000);

  it("captain mode: reject with unknown peerId returns error", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_reject_patches",
      arguments: { peerId: "nonexistent-peer" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/no pending/i);
  }, 30_000);

  it("captain mode: per-peer batching accumulates multiple file-changes", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const queue = state!.hostSession!.patchReviewQueue;
    const update1 = makeFileChange("peer-C", "src/a.ts", "h0", "h1");
    const update2 = makeFileChange("peer-C", "src/b.ts", "h0", "h1");
    const id1 = queue.enqueue(update1, "peer-C");
    const id2 = queue.enqueue(update2, "peer-C");

    // Same batch — stable reviewId
    expect(id1).toBe(id2);

    const approveResult = await client!.callTool({
      name: "hoop_approve_patches",
      arguments: { peerId: "peer-C" },
    });
    const data = parseJson(approveResult) as { approved: boolean; fileCount: number; seqNos: number[] };
    expect(data.approved).toBe(true);
    expect(data.fileCount).toBe(2);
    expect(data.seqNos).toHaveLength(2);
  }, 30_000);

  it("captain mode: hoop_poll_patch_status returns status for known reviewId", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const queue = state!.hostSession!.patchReviewQueue;
    const update = makeFileChange("peer-D", "src/x.ts", "h0", "h1");
    const reviewId = queue.enqueue(update, "peer-D");

    const pollResult = await client!.callTool({
      name: "hoop_poll_patch_status",
      arguments: { reviewId },
    });
    const pollData = parseJson(pollResult) as { reviewId: string; status: string };
    expect(pollData.reviewId).toBe(reviewId);
    expect(pollData.status).toBe("pending-review");

    // Approve and re-poll
    queue.approve("peer-D");
    const pollResult2 = await client!.callTool({
      name: "hoop_poll_patch_status",
      arguments: { reviewId },
    });
    const pollData2 = parseJson(pollResult2) as { status: string };
    expect(pollData2.status).toBe("approved");
  }, 30_000);

  it("captain mode: hoop_poll_patch_status returns error for unknown reviewId", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const result = await client!.callTool({
      name: "hoop_poll_patch_status",
      arguments: { reviewId: "nonexistent-id" },
    });
    expect(result.isError).toBe(true);
  }, 30_000);

  it("captain mode: approve detects baseHash conflicts at approve time", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    const queue = state!.hostSession!.patchReviewQueue;
    const update = makeFileChange("peer-E", "src/conflict.ts", "old-hash", "new-hash");
    queue.enqueue(update, "peer-E");

    // Simulate the file being changed by the host between enqueue and approve
    // by publishing a host-side file-change that changes the file hash
    state!.hostSession!.accumulator.accumulate({
      type: "file-change",
      peerId: state!.hostSession!.peerId,
      filePath: "src/conflict.ts",
      patch: VALID_PATCH,
      baseHash: "old-hash",
      resultHash: "host-changed-hash",
      timestamp: Date.now(),
    });

    const approveResult = await client!.callTool({
      name: "hoop_approve_patches",
      arguments: { peerId: "peer-E" },
    });
    const data = parseJson(approveResult) as { approved: boolean; conflicts: string[]; fileCount: number };
    expect(data.approved).toBe(false); // all entries conflicted → treated as rejection
    expect(data.conflicts).toContain("src/conflict.ts");
    expect(data.fileCount).toBe(0);
  }, 30_000);

  it("captain mode: non-file-change updates pass through ungated", async () => {
    ({ server, state, client } = await setup());

    await client!.callTool({
      name: "hoop_create_session",
      arguments: { executionTarget: "host-only" },
    });

    // Default mode is captain
    expect(state!.observedGovernanceConfig.mode).toBe("captain");

    // Cursor updates should not be gated
    const queue = state!.hostSession!.patchReviewQueue;
    expect(queue.listPending()).toHaveLength(0);

    // Host-side send of cursor update should succeed directly
    const result = await client!.callTool({
      name: "hoop_send_update",
      arguments: {
        type: "cursor-update",
        filePath: "src/app.ts",
        line: 10,
        column: 5,
      },
    });
    const data = parseJson(result) as { accepted: boolean; seqNo: number };
    expect(data.accepted).toBe(true);
    expect(typeof data.seqNo).toBe("number");

    // Queue still empty — cursor was not gated
    expect(queue.listPending()).toHaveLength(0);
  }, 30_000);
});
