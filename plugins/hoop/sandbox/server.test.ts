/**
 * server.test.ts — integration tests for the HTTP router in server.ts.
 *
 * Tests focus on the POST /skill/:name/run handler (the protocol-mismatch fix)
 * and verify that existing auth/rate-limit invariants still hold.
 *
 * Strategy: vi.mock() all heavy transitive deps before importing server.ts,
 * then start a real http.Server on a temp Unix socket and make requests with
 * node's built-in http.request. No external process is spawned.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest, type IncomingMessage } from "node:http";
// Mocked (see vi.mock below) — imported here so the bash test can inspect calls.
import { ingestEventLine } from "./lib/ingestor";
import { markSessionActive } from "./lib/active-sessions";

// ---- mock heavy deps before any import of server.ts ----

const mockRunsBus = new EventEmitter();
mockRunsBus.setMaxListeners(50);

const mockStartSkillRun = vi.fn<(skill: string, args?: string) => { runId: string }>();

vi.mock("./lib/spawn", () => ({
  startSkillRun: (...a: Parameters<typeof mockStartSkillRun>) => mockStartSkillRun(...a),
  listRuns: () => [],
  getRun: () => undefined,
  isValidSkillName: (name: string) => /^[A-Za-z0-9][A-Za-z0-9_:/-]{0,127}$/.test(name),
  runsBus: mockRunsBus,
}));

vi.mock("./lib/ingestor", () => ({
  ingestEventLine: vi.fn(() => ({ ok: true, id: 1 })),
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
  // Bash/chat side-channels: a live session in a real, writable cwd so `spawn`
  // works, plus the wake + active-marking hooks (asserted by the bash test).
  getActiveSession: vi.fn((id: string) => ({ sessionId: id, cwd: "/tmp", status: "alive" })),
  markSessionActive: vi.fn(),
  wakeSession: vi.fn(async () => ({})),
  popPendingAuthor: vi.fn(() => ({ author: null, thumbnails: null, kind: null })),
  markTurnFinished: vi.fn(),
  activeSessionsBus: new EventEmitter(),
  bootActiveSessions: vi.fn(),
  startIdleSweeper: vi.fn(),
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

// ---- helpers ----

interface TestServer {
  socketPath: string;
  token: string;
  close(): Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-server-test-"));
  const socketPath = join(dir, "sandbox.sock");
  const tokenFile = join(dir, "sandbox.token");
  const token = "test-token-".padEnd(64, "x");
  writeFileSync(tokenFile, token);

  // Point auth module at our temp token file.
  process.env.HOOP_SANDBOX_TOKEN_FILE = tokenFile;

  // Re-import server after mocks are installed so the route table is fresh.
  const { createSandboxServer } = await import("./server");
  const server = createSandboxServer();

  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

  return {
    socketPath,
    token,
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

interface Response {
  status: number;
  contentType: string | undefined;
  body: string;
}

function doRequest(
  socketPath: string,
  method: string,
  path: string,
  token: string,
  body?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "x-sandbox-token": token,
    };
    if (body != null) {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const req = httpRequest(
      { socketPath, method, path, headers },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const ct = res.headers["content-type"];
          resolve({
            status: res.statusCode ?? 0,
            contentType: Array.isArray(ct) ? ct[0] : ct,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// ---- tests ----

let srv: TestServer;

beforeEach(async () => {
  vi.resetModules();
  mockStartSkillRun.mockReset();
  srv = await startTestServer();
});

afterEach(async () => {
  await srv.close();
  delete process.env.HOOP_SANDBOX_TOKEN_FILE;
});

describe("POST /skill/:name/run — JSON response contract", () => {
  it("returns 200 application/json { runId } when spawn succeeds", async () => {
    mockStartSkillRun.mockReturnValueOnce({ runId: "test-run-id-123" });

    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/triage-issue/run",
      srv.token,
      JSON.stringify({ args: "check ticket JIRA-42" }),
    );

    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/application\/json/);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({ runId: "test-run-id-123" });
    expect(parsed.runId).toBeTypeOf("string");
    expect(parsed.runId.length).toBeGreaterThan(0);
  });

  it("does NOT send text/event-stream (old broken behaviour)", async () => {
    mockStartSkillRun.mockReturnValueOnce({ runId: "r1" });

    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/my-skill/run",
      srv.token,
      JSON.stringify({ args: "" }),
    );

    expect(res.contentType).not.toMatch(/text\/event-stream/);
  });

  it("passes skill name and args to startSkillRun", async () => {
    mockStartSkillRun.mockReturnValueOnce({ runId: "r2" });

    await doRequest(
      srv.socketPath,
      "POST",
      "/skill/my-day/run",
      srv.token,
      JSON.stringify({ args: "some args here" }),
    );

    expect(mockStartSkillRun).toHaveBeenCalledWith("my-day", "some args here");
  });

  it("returns 404 application/json when skill is unknown", async () => {
    mockStartSkillRun.mockImplementationOnce(() => {
      throw new Error("unknown skill or command: no-such-skill");
    });

    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/no-such-skill/run",
      srv.token,
      JSON.stringify({ args: "" }),
    );

    expect(res.status).toBe(404);
    expect(res.contentType).toMatch(/application\/json/);
    const parsed = JSON.parse(res.body);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toMatch(/unknown skill or command/);
  });

  it("returns 400 for an invalid skill name (contains space)", async () => {
    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/not%20valid/run",
      srv.token,
      JSON.stringify({ args: "" }),
    );

    expect(res.status).toBe(400);
    expect(res.contentType).toMatch(/application\/json/);
  });

  it("returns 400 when body is not application/json", async () => {
    const req = httpRequest(
      {
        socketPath: srv.socketPath,
        method: "POST",
        path: "/skill/my-skill/run",
        headers: {
          "x-sandbox-token": srv.token,
          "content-type": "text/plain",
          "content-length": "4",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          expect(res.statusCode).toBe(415);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          expect(typeof body.error).toBe("string");
        });
      }
    );
    req.write("hi{}");
    await new Promise<void>((resolve, reject) => {
      req.on("error", reject);
      req.end(resolve);
    });
  });

  it("returns 401 when sandbox token is missing", async () => {
    mockStartSkillRun.mockReturnValueOnce({ runId: "r3" });

    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/my-skill/run",
      "wrong-token-" + "x".repeat(52),
      JSON.stringify({ args: "" }),
    );

    expect(res.status).toBe(401);
    expect(res.contentType).toMatch(/application\/json/);
  });

  it("returns 413 (or connection reset) when body exceeds size limit (>16KB)", async () => {
    // Body limit is MAX_BYTES_ARGS = 16 * 1024. The server calls req.destroy()
    // after the limit is exceeded, which may close the connection before the
    // 413 response is fully written — clients see either a 413 or ECONNRESET.
    const hugeArgs = "x".repeat(20 * 1024);
    const body = JSON.stringify({ args: hugeArgs });
    let status: number | undefined;
    try {
      const res = await doRequest(
        srv.socketPath,
        "POST",
        "/skill/my-skill/run",
        srv.token,
        body,
      );
      status = res.status;
    } catch (e: any) {
      // ECONNRESET is acceptable: the server aborted the over-size request.
      if (e?.code !== "ECONNRESET" && e?.message !== "socket hang up") throw e;
      status = 413; // treat connection reset as effective 413
    }
    expect(status).toBe(413);
  });
});

describe("/events/stream — run events propagate via runsBus", () => {
  /**
   * Opens an SSE connection and returns a function that collects frames
   * up to `count` then resolves. Yields collected frames.
   */
  function collectSseFrames(count: number): Promise<Array<{ event: string | null; data: string }>> {
    return new Promise((resolve, reject) => {
      const frames: Array<{ event: string | null; data: string }> = [];
      const req = httpRequest(
        {
          socketPath: srv.socketPath,
          method: "GET",
          path: "/events/stream",
          headers: { "x-sandbox-token": srv.token },
        },
        (res) => {
          if (res.statusCode !== 200) { reject(new Error(`SSE returned ${res.statusCode}`)); return; }
          res.setEncoding("utf-8");
          let buf = "";
          let curEvent: string | null = null;
          const dataLines: string[] = [];

          const flush = () => {
            if (dataLines.length === 0) { curEvent = null; return; }
            frames.push({ event: curEvent, data: dataLines.join("\n") });
            curEvent = null;
            dataLines.length = 0;
            if (frames.length >= count) {
              req.destroy();
              resolve(frames);
            }
          };

          res.on("data", (chunk: string) => {
            buf += chunk;
            let idx: number;
            while ((idx = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, idx).replace(/\r$/, "");
              buf = buf.slice(idx + 1);
              if (line === "") { flush(); continue; }
              if (line.startsWith(":")) continue;
              if (line.startsWith("event:")) { curEvent = line.slice(6).trim(); continue; }
              if (line.startsWith("data:")) { dataLines.push(line.slice(5).replace(/^ /, "")); continue; }
            }
          });
          res.on("error", (e) => { if (frames.length < count) reject(e); });
        }
      );
      req.on("error", (e) => { if (frames.length < count) reject(e); });
      req.end();

      // Safety timeout.
      setTimeout(() => {
        if (frames.length < count) reject(new Error(`SSE timeout: got ${frames.length}/${count} frames`));
      }, 2000);
    });
  }

  it("forwards run-chunk from runsBus as SSE event: run-chunk", async () => {
    const p = collectSseFrames(1);

    // Give the SSE connection a tick to establish before emitting.
    await new Promise((r) => setTimeout(r, 30));

    mockRunsBus.emit("chunk", { runId: "rx1", skill: "foo", kind: "stdout", data: "hello" });

    const frames = await p;
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("run-chunk");
    const payload = JSON.parse(frames[0].data);
    expect(payload).toMatchObject({ runId: "rx1", kind: "stdout", data: "hello" });
  });

  it("forwards run-end from runsBus as SSE event: run-end", async () => {
    const p = collectSseFrames(1);
    await new Promise((r) => setTimeout(r, 30));

    mockRunsBus.emit("end", { runId: "rx2", skill: "foo", exitCode: 0, signal: null, durationMs: 100 });

    const frames = await p;
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("run-end");
    const payload = JSON.parse(frames[0].data);
    expect(payload).toMatchObject({ runId: "rx2", exitCode: 0 });
  });
});

describe("POST /skill/:name/run — runId returned matches later runsBus emissions", () => {
  it("runId from JSON response is the same one carried in subsequent runsBus events", async () => {
    let capturedRunId: string | undefined;

    // Intercept the startSkillRun call so we can grab its returned runId,
    // then synchronously emit a chunk before the HTTP response arrives.
    mockStartSkillRun.mockImplementationOnce((skill, args) => {
      const { randomUUID } = require("node:crypto");
      capturedRunId = randomUUID() as string;
      // Schedule the chunk and end events to fire after the response is sent.
      setImmediate(() => {
        mockRunsBus.emit("chunk", { runId: capturedRunId, skill, kind: "stdout", data: "output" });
        mockRunsBus.emit("end", { runId: capturedRunId, skill, exitCode: 0, signal: null, durationMs: 5 });
      });
      return { runId: capturedRunId };
    });

    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/my-skill/run",
      srv.token,
      JSON.stringify({ args: "run it" }),
    );

    expect(res.status).toBe(200);
    const { runId } = JSON.parse(res.body);
    expect(runId).toBe(capturedRunId);
  });
});

// The `!bash` fast lane streams: the sandbox emits a "running" BashShortcut
// snapshot and RESPONDS IMMEDIATELY, then emits throttled progress snapshots and
// a final "done" snapshot as the command runs. This is what keeps a long-running
// command from blocking (and timing out) the request, and what lets the
// transcript render a live card. Every snapshot shares one run_id.
describe("POST /sessions/:id/bash — streaming snapshots", () => {
  const snapshots = () =>
    (ingestEventLine as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((e) => e.hook === "BashShortcut")
      .map((e) => e.ctx.tool_response);

  // The command runs in the BACKGROUND (that's the feature), so a test must wait
  // for the terminal snapshot before asserting — and before afterEach tears the
  // server down (closeAllConnections would kill the in-flight child).
  const waitForDone = async (timeoutMs = 5_000): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const done = snapshots().find((s) => s.status === "done");
      if (done) return done;
      if (Date.now() > deadline) throw new Error("timed out waiting for the 'done' snapshot");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("responds immediately with a runId and a 'running' snapshot, before the command finishes", async () => {
    (ingestEventLine as unknown as ReturnType<typeof vi.fn>).mockClear();
    const startedAt = Date.now();
    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/sessions/sid-bash-1/bash",
      srv.token,
      JSON.stringify({ command: "sleep 0.6; echo late-output" }),
    );
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.runId).toBe("string");
    // The whole point: the response does NOT wait for the command.
    expect(elapsed).toBeLessThan(500);

    const first = snapshots();
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("running");
    expect(first[0].run_id).toBe(body.runId);
    expect(first[0].exit_code).toBeNull();

    // ...and the final "done" snapshot lands later, with the output + exit code,
    // sharing the same run_id so the UI updates one card in place.
    const done = await waitForDone();
    expect(done.run_id).toBe(body.runId);
    expect(done.exit_code).toBe(0);
    expect(done.stdout).toContain("late-output");
    expect(snapshots().every((s) => s.run_id === body.runId)).toBe(true);
  });

  it("marks the session active (and wakes it) for a side-channel bash", async () => {
    (ingestEventLine as unknown as ReturnType<typeof vi.fn>).mockClear();
    (markSessionActive as unknown as ReturnType<typeof vi.fn>).mockClear();
    await doRequest(
      srv.socketPath,
      "POST",
      "/sessions/sid-bash-2/bash",
      srv.token,
      JSON.stringify({ command: "echo quick" }),
    );
    expect((markSessionActive as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect((markSessionActive as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("sid-bash-2");
    await waitForDone(); // let the child finish before teardown
  });

  it("reports a non-zero exit code on the done snapshot", async () => {
    (ingestEventLine as unknown as ReturnType<typeof vi.fn>).mockClear();
    await doRequest(
      srv.socketPath,
      "POST",
      "/sessions/sid-bash-3/bash",
      srv.token,
      JSON.stringify({ command: "exit 3" }),
    );
    const done = await waitForDone();
    expect(done.exit_code).toBe(3);
  });
});
