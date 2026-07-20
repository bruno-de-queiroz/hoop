/**
 * Boundary tests for the runtime resource caps: MAX_SSE_CLIENTS and the
 * socket-conflict probe in listenOnSocket. The skill-run cap is covered by
 * lib/spawn.test.ts; this file focuses on the server-side gates.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest, type IncomingMessage } from "node:http";

const mockRunsBus = new EventEmitter();
mockRunsBus.setMaxListeners(50);

vi.mock("./lib/spawn", () => ({
  startSkillRun: vi.fn(),
  listRuns: () => [],
  getRun: () => undefined,
  isValidSkillName: () => true,
  runsBus: mockRunsBus,
}));
vi.mock("./lib/ingestor", () => ({
  ingestEventLine: vi.fn(),
  startIngestor: vi.fn(),
  eventBus: new EventEmitter(),
}));
vi.mock("./lib/sessions", () => ({
  listSessions: () => [],
  startSessionsWatcher: vi.fn(),
  stopSessionsWatcher: vi.fn(),
  sessionsBus: new EventEmitter(),
}));
vi.mock("./lib/active-sessions", () => ({
  startNewConversation: vi.fn(),
  writeUserTurn: vi.fn(),
  isControllable: vi.fn(() => false),
  endSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  activeSessionsBus: new EventEmitter(),
  bootActiveSessions: vi.fn(),
  shutdownActiveSessions: vi.fn(),
}));
vi.mock("./lib/skills", () => ({ listSkills: () => [], startSkillsWatcher: vi.fn(), stopSkillsWatcher: vi.fn(), skillsBus: new EventEmitter() }));
vi.mock("./lib/commands", () => ({ listSlashCommands: () => [] }));
vi.mock("./lib/agents", () => ({ listAgentRuns: () => [], getAgentDetail: () => undefined }));
vi.mock("./lib/search", () => ({ search: vi.fn(async () => ({ results: [], total: 0 })) }));
vi.mock("./lib/mcps", () => ({ listMcps: () => ({ servers: [] }) }));
vi.mock("./lib/stack", () => ({ getStack: () => ({ plugins: [] }) }));
vi.mock("./lib/identity", () => ({ getIdentity: () => ({ authenticated: false }) }));
vi.mock("./lib/session-model", () => ({ getSessionModel: () => ({ model: null }) }));
vi.mock("./lib/events-query", () => ({ listEvents: () => [], getEvent: () => undefined }));
vi.mock("./lib/cwd-policy", () => ({ isAllowedCwd: () => ({ ok: true }) }));
vi.mock("./lib/db", () => ({ backupEventsDb: vi.fn(), checkpointDb: vi.fn() }));
vi.mock("./rate-limit", () => ({
  mutatingLimiter: { check: vi.fn(() => ({ ok: true })) },
}));
vi.mock("./logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("./shutdown", () => ({ registerShutdown: vi.fn() }));

interface CapsServer {
  socketPath: string;
  token: string;
  server: import("node:http").Server;
  close(): Promise<void>;
}

async function startServerWith(envOverrides: Record<string, string>): Promise<CapsServer> {
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), "sandbox-caps-test-"));
  const socketPath = join(dir, "sandbox.sock");
  const tokenFile = join(dir, "sandbox.token");
  const token = "test-token-".padEnd(64, "x");
  writeFileSync(tokenFile, token);
  process.env.HOOP_SANDBOX_TOKEN_FILE = tokenFile;

  const { createSandboxServer } = await import("./server");
  const server = createSandboxServer();
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

  return {
    socketPath,
    token,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          if (existsSync(socketPath)) try { unlinkSync(socketPath); } catch { /* ignore */ }
          resolve();
        });
      }),
  };
}

function postJson(socketPath: string, token: string, path: string, participant?: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "x-sandbox-token": token,
      "content-type": "application/json",
    };
    if (participant) headers["x-hoop-participant"] = participant;
    const body = "{}";
    headers["content-length"] = String(Buffer.byteLength(body));
    const req = httpRequest({ socketPath, method: "POST", path, headers }, (res) => {
      res.resume(); // drain so the socket closes
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function openSseConnection(socketPath: string, token: string): Promise<{
  status: number;
  headers: IncomingMessage["headers"];
  destroy: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      method: "GET",
      path: "/events/stream",
      headers: { "x-sandbox-token": token },
    }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        destroy: () => { req.destroy(); res.destroy(); },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("probeSocketAlive — socket-conflict detection for listenOnSocket", () => {
  it("returns true when another listener is alive on the socket path", async () => {
    const net = await import("node:net");
    const dir = mkdtempSync(join(tmpdir(), "sandbox-probe-test-"));
    const socketPath = join(dir, "live.sock");
    const dummy = net.createServer();
    await new Promise<void>((resolve) => dummy.listen(socketPath, () => resolve()));

    const { probeSocketAlive } = await import("./server");
    const alive = await probeSocketAlive(socketPath, 500);
    expect(alive).toBe(true);

    await new Promise<void>((resolve) => dummy.close(() => resolve()));
    if (existsSync(socketPath)) try { unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it("returns false for a stale socket file with no listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-probe-test-"));
    const socketPath = join(dir, "stale.sock");
    // Create the file but don't bind a server — simulates a crash-leftover.
    writeFileSync(socketPath, "");

    const { probeSocketAlive } = await import("./server");
    const alive = await probeSocketAlive(socketPath, 200);
    expect(alive).toBe(false);

    if (existsSync(socketPath)) try { unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it("returns false for a non-existent path", async () => {
    const { probeSocketAlive } = await import("./server");
    const alive = await probeSocketAlive("/tmp/does-not-exist-" + Date.now() + ".sock", 200);
    expect(alive).toBe(false);
  });
});

describe("host-only spawn guards (requireHost) — defence-in-depth", () => {
  let srv: CapsServer;

  afterEach(async () => {
    if (srv) await srv.close();
  });

  it("POST /sessions rejects a forwarded peer with 403, allows host + internal (no header)", async () => {
    srv = await startServerWith({});
    // A peer participant the dashboard should have blocked — sandbox rejects it too.
    expect((await postJson(srv.socketPath, srv.token, "/sessions", "peer:share-x")).status).toBe(403);
    // Host and internal (no participant header) get past the guard. The mocked
    // startNewConversation returns undefined → the handler 500s downstream; the
    // point is only that requireHost did NOT short-circuit with a 403.
    expect((await postJson(srv.socketPath, srv.token, "/sessions", "host")).status).not.toBe(403);
    expect((await postJson(srv.socketPath, srv.token, "/sessions")).status).not.toBe(403);
  });

  it("POST /skill/:name/run rejects a forwarded peer with 403, allows host", async () => {
    srv = await startServerWith({});
    expect((await postJson(srv.socketPath, srv.token, "/skill/foo/run", "peer:share-x")).status).toBe(403);
    expect((await postJson(srv.socketPath, srv.token, "/skill/foo/run", "host")).status).not.toBe(403);
  });
});

describe("/events/stream — SSE client cap", () => {
  let srv: CapsServer;

  afterEach(async () => {
    delete process.env.HOOP_MAX_SSE_CLIENTS;
    if (srv) await srv.close();
  });

  it("accepts the Nth client and rejects the (N+1)th with 503 + Retry-After", async () => {
    srv = await startServerWith({ HOOP_MAX_SSE_CLIENTS: "1" });

    const first = await openSseConnection(srv.socketPath, srv.token);
    expect(first.status).toBe(200);

    const second = await openSseConnection(srv.socketPath, srv.token);
    expect(second.status).toBe(503);
    expect(second.headers["retry-after"]).toBe("10");

    first.destroy();
    second.destroy();
  });

  it("decrements the counter when a client disconnects, allowing a new one", async () => {
    srv = await startServerWith({ HOOP_MAX_SSE_CLIENTS: "1" });

    const first = await openSseConnection(srv.socketPath, srv.token);
    expect(first.status).toBe(200);

    first.destroy();
    // Give the server a tick to process the close event.
    await new Promise((r) => setTimeout(r, 50));

    const second = await openSseConnection(srv.socketPath, srv.token);
    expect(second.status).toBe(200);
    second.destroy();
  });
});
