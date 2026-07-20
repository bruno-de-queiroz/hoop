import { vi, describe, it, expect, beforeEach } from "vitest";

interface VirtualFile {
  content: string;
  mtime: Date;
  size: number;
}

const fs = vi.hoisted(() => ({
  files: new Map<string, VirtualFile>(),
  dirs: new Set<string>(),
  reset() {
    this.files.clear();
    this.dirs.clear();
  },
  putFile(path: string, content: string, mtime = new Date()) {
    this.files.set(path, { content, mtime, size: content.length });
  },
  putDir(path: string) {
    this.dirs.add(path);
  },
  putSession(file: string, body: Record<string, unknown>, mtime = new Date()) {
    this.putFile(file, JSON.stringify(body), mtime);
  },
}));

vi.mock("node:fs", () => {
  const existsSync = vi.fn((p: string) => fs.files.has(p) || fs.dirs.has(p));
  const statSync = vi.fn((p: string) => {
    const f = fs.files.get(p);
    if (f) return { mtime: f.mtime, size: f.size, isDirectory: () => false } as any;
    if (fs.dirs.has(p)) return { mtime: new Date(), size: 0, isDirectory: () => true } as any;
    throw new Error(`ENOENT: ${p}`);
  });
  const readFileSync = vi.fn((p: string) => {
    const f = fs.files.get(p);
    if (!f) throw new Error(`ENOENT: ${p}`);
    return f.content;
  });
  const readdirSync = vi.fn((p: string) => {
    const out: string[] = [];
    const prefix = p.endsWith("/") ? p : p + "/";
    for (const file of fs.files.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
        out.push(file.slice(prefix.length));
      }
    }
    return out;
  });
  const unlinkSync = vi.fn((p: string) => { fs.files.delete(p); });
  const watch = vi.fn(() => ({ close: vi.fn() }));
  const api = { existsSync, statSync, readFileSync, readdirSync, unlinkSync, watch };
  return { ...api, default: api };
});

vi.mock("./active-sessions", () => ({
  getActiveSession: vi.fn(() => undefined),
  listActiveSessions: vi.fn(() => []),
  bootActiveSessions: vi.fn(),
  aliasesFor: vi.fn(() => []),
  // Default: no resume in flight, so orphan-suppression is inert and the
  // existing dedupe assertions hold. The resume-suppression case overrides
  // this per-test.
  isResumeInFlight: vi.fn(() => false),
}));

vi.mock("./spawn", () => ({
  getRunForSession: vi.fn(() => null),
}));

vi.mock("./paths", () => ({
  CLAUDE_SESSIONS_DIR: "/mock/sessions",
}));

let mod: typeof import("./sessions");
let active: typeof import("./active-sessions");
let unlinkSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  fs.reset();
  fs.putDir("/mock/sessions");
  mod = await import("./sessions");
  active = await import("./active-sessions");
  (active.getActiveSession as any).mockReset().mockReturnValue(undefined);
  (active.listActiveSessions as any).mockReset().mockReturnValue([]);
  (active.isResumeInFlight as any).mockReset().mockReturnValue(false);
  const spawn = await import("./spawn");
  (spawn.getRunForSession as any).mockReset().mockReturnValue(null);
  const fsMod = await import("node:fs");
  unlinkSpy = (fsMod as any).unlinkSync;
  unlinkSpy.mockClear();
});

describe("isPidAlive", () => {
  it("returns true for the test runner's own pid (definitely alive)", () => {
    expect(mod.isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for an obviously dead pid", () => {
    expect(mod.isPidAlive(2 ** 22)).toBe(false);
  });

  it("returns true when process.kill throws EPERM (exists, no permission)", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err: any = new Error("EPERM"); err.code = "EPERM"; throw err;
    });
    expect(mod.isPidAlive(1)).toBe(true);
    spy.mockRestore();
  });
});

describe("readSessionMeta", () => {
  it("returns parsed metadata for a healthy session file", () => {
    fs.putSession("/mock/sessions/12345.json", {
      sessionId: "sess-abc",
      pid: process.pid,
      cwd: "/work",
      entrypoint: "sdk-cli",
      kind: "interactive",
      version: "2.1.138",
      status: "idle",
      startedAt: 1700000000,
      updatedAt: 1700000100,
    });
    const out = mod.readSessionMeta("/mock/sessions/12345.json");
    expect(out).toMatchObject({
      id: "12345",
      sessionId: "sess-abc",
      pid: process.pid,
      cwd: "/work",
      entrypoint: "sdk-cli",
    });
  });

  it("prunes a stale sdk-cli file when its pid is dead", () => {
    fs.putSession("/mock/sessions/99999.json", {
      sessionId: "sess-stale",
      pid: 2 ** 22,
      cwd: "/work",
      entrypoint: "sdk-cli",
    });
    const out = mod.readSessionMeta("/mock/sessions/99999.json");
    expect(out).toBeNull();
    expect(unlinkSpy).toHaveBeenCalledWith("/mock/sessions/99999.json");
  });

  it("does NOT unlink a stale TUI (cli) file — its pid namespace is foreign", () => {
    fs.putSession("/mock/sessions/77.json", {
      sessionId: "sess-tui",
      pid: 2 ** 22,
      cwd: "/work",
      entrypoint: "cli",
    });
    const out = mod.readSessionMeta("/mock/sessions/77.json");
    expect(out).not.toBeNull();
    expect(out?.entrypoint).toBe("cli");
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("does NOT unlink an sdk-cli file with a live pid", () => {
    fs.putSession("/mock/sessions/live.json", {
      sessionId: "sess-live",
      pid: process.pid,
      cwd: "/work",
      entrypoint: "sdk-cli",
    });
    const out = mod.readSessionMeta("/mock/sessions/live.json");
    expect(out?.sessionId).toBe("sess-live");
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("returns surface fields even when JSON body is corrupt", () => {
    fs.putFile("/mock/sessions/corrupt.json", "{this is not json");
    const out = mod.readSessionMeta("/mock/sessions/corrupt.json");
    expect(out).not.toBeNull();
    expect(out?.id).toBe("corrupt");
    expect(out?.sessionId).toBeUndefined();
  });

  it("returns null when statSync throws (file disappeared mid-read)", () => {
    const out = mod.readSessionMeta("/mock/sessions/never-existed.json");
    expect(out).toBeNull();
  });
});

describe("listSessions", () => {
  beforeEach(() => {
    fs.putSession("/mock/sessions/100.json", {
      sessionId: "sess-100",
      pid: process.pid,
      cwd: "/a",
      entrypoint: "sdk-cli",
    });
    mod.startSessionsWatcher();
  });

  it("returns one row per fresh cached session file", () => {
    const out = mod.listSessions();
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe("sess-100");
  });

  it("decorates with active-sessions lifecycle when registry has a matching entry", () => {
    (active.getActiveSession as any).mockImplementation((id: string) =>
      id === "sess-100" ? { sessionId: "sess-100", status: "alive", displayName: "n" } : undefined
    );
    const out = mod.listSessions();
    expect(out[0].lifecycle).toBe("alive");
    expect(out[0].controllable).toBe(true);
    expect(out[0].displayName).toBe("n");
  });

  it("backfills startedAt from the registry when the session file lacks one", () => {
    // The beforeEach cache file for sess-100 has no startedAt in its body.
    (active.getActiveSession as any).mockImplementation((id: string) =>
      id === "sess-100" ? { sessionId: "sess-100", status: "alive", startedAt: 1699999999 } : undefined
    );
    const out = mod.listSessions();
    expect(out[0].startedAt).toBe(1699999999);
  });

  it("marks expired sessions as not controllable", () => {
    (active.getActiveSession as any).mockReturnValue({ sessionId: "sess-100", status: "expired" });
    const out = mod.listSessions();
    expect(out[0].lifecycle).toBe("expired");
    expect(out[0].controllable).toBe(false);
  });

  it("surfaces a dormant registry entry that has no live session file", () => {
    (active.listActiveSessions as any).mockReturnValue([
      { sessionId: "sess-dormant", status: "dormant", cwd: "/elsewhere", startedAt: 1700000000, lastSeenAt: Date.now(), via: "new-conversation" },
    ]);
    const out = mod.listSessions();
    const dormant = out.find((s) => s.sessionId === "sess-dormant");
    expect(dormant).toBeDefined();
    expect(dormant?.lifecycle).toBe("dormant");
    // Creation date comes from the registry so the rail can sort by it.
    expect(dormant?.startedAt).toBe(1700000000);
  });

  it("surfaces a freshly-created alive session immediately, even when a cache entry shares its cwd", () => {
    // The core of the lifecycle fix: a dashboard session owns its id from spawn
    // (--session-id) and is first-class from creation — no model turn, no
    // <pid>.json file yet. The base cache row (sess-100) shares the /a cwd; the
    // OLD code suppressed this registry row on that cwd match, hiding brand-new
    // sessions in the shared workspace. It must now be visible.
    (active.listActiveSessions as any).mockReturnValue([
      { sessionId: "fresh-real-id", status: "alive", cwd: "/a", lastSeenAt: Date.now(), via: "new-conversation", displayName: "witty-humble-turing" },
    ]);
    const out = mod.listSessions();
    const row = out.find((s) => s.sessionId === "fresh-real-id");
    expect(row).toBeDefined();
    expect(row?.lifecycle).toBe("alive");
    expect(row?.displayName).toBe("witty-humble-turing");
    expect(out).toHaveLength(2);
  });

  it("WAKE: KEEPS a resumed real-id alive entry even when an sdk-cli cache entry shares the cwd", () => {
    // Regression guard for the vanishing-row bug. On a cold wake the slot is
    // alive under its REAL id (e.g. wake-A) while `claude --resume` has written
    // a <pid>.json under the SAME shared workspace cwd. The cwd-based collapse
    // must NOT suppress this real-id entry (only `pending-` new-spawn halves),
    // otherwise the session vanishes from /sessions mid-wake and the header
    // flashes a short-hash id. The named registry row must stay present.
    (active.listActiveSessions as any).mockReturnValue([
      {
        sessionId: "wake-A", status: "alive", cwd: "/a",
        lastSeenAt: Date.now(), via: "resumed", displayName: "calm-nesting-thompson",
      },
    ]);
    const out = mod.listSessions();
    const row = out.find((s) => s.sessionId === "wake-A");
    expect(row).toBeDefined();
    expect(row?.displayName).toBe("calm-nesting-thompson");
  });

  it("DEDUPE wake race: keeps an ENDED / dormant entry even when cache has the same cwd (real history matters)", () => {
    (active.listActiveSessions as any).mockReturnValue([
      { sessionId: "old-A", status: "ended", cwd: "/a", lastSeenAt: Date.now(), via: "resumed" },
    ]);
    const out = mod.listSessions();
    expect(out.find((s) => s.sessionId === "old-A")).toBeDefined();
    expect(out).toHaveLength(2);
  });

  it("DEDUPE within-cache: two <pid>.json files sharing one sessionId surface as a single row (freshest wins)", () => {
    // Same conversation, two PID files: e.g. TUI claude wrote one, the
    // dashboard's --resume spawn wrote another. Both end up in _cache.
    fs.putSession(
      "/mock/sessions/100-old.json",
      { sessionId: "shared-id", pid: process.pid, cwd: "/a", entrypoint: "sdk-cli" },
      new Date(Date.now() - 60_000)
    );
    fs.putSession(
      "/mock/sessions/100-new.json",
      { sessionId: "shared-id", pid: process.pid, cwd: "/a", entrypoint: "sdk-cli" },
      new Date()
    );
    vi.resetModules();
    return import("./sessions").then((fresh) => {
      fresh.startSessionsWatcher();
      const out = fresh.listSessions();
      const rows = out.filter((s) => s.sessionId === "shared-id");
      expect(rows).toHaveLength(1);
      // The fresher mtime should win.
      expect(rows[0].path).toContain("100-new.json");
    });
  });

  it("WAKE: suppresses an undecorated sdk-cli orphan cache row while a resume is in flight for its cwd", () => {
    // The base beforeEach cache row (sess-100, cwd /a, sdk-cli) has NO
    // registry decoration (getActiveSession default → undefined). With a
    // resume in flight for /a, it's the mid-swap orphan → suppressed.
    (active.isResumeInFlight as any).mockImplementation((cwd: string) => cwd === "/a");
    const out = mod.listSessions();
    expect(out.find((s) => s.sessionId === "sess-100")).toBeUndefined();
  });

  it("WAKE: keeps the orphan row once it gains registry decoration (post-swap)", () => {
    (active.isResumeInFlight as any).mockImplementation((cwd: string) => cwd === "/a");
    (active.getActiveSession as any).mockImplementation((id: string) =>
      id === "sess-100" ? { sessionId: "sess-100", status: "alive", displayName: "haiku-name" } : undefined
    );
    const out = mod.listSessions();
    const row = out.find((s) => s.sessionId === "sess-100");
    expect(row).toBeDefined();
    expect(row?.displayName).toBe("haiku-name");
  });

  it("WAKE: does NOT suppress when no resume is in flight (steady state)", () => {
    (active.isResumeInFlight as any).mockReturnValue(false);
    const out = mod.listSessions();
    expect(out.find((s) => s.sessionId === "sess-100")).toBeDefined();
  });

  it("sorts results by mtime descending", async () => {
    fs.putSession("/mock/sessions/200.json", {
      sessionId: "sess-200",
      pid: process.pid,
      cwd: "/b",
      entrypoint: "sdk-cli",
    }, new Date(Date.now() + 60_000));
    // Re-trigger the cache build by re-importing.
    vi.resetModules();
    const fresh = await import("./sessions");
    fresh.startSessionsWatcher();
    const out = fresh.listSessions();
    expect(out[0].sessionId).toBe("sess-200");
    expect(out[1].sessionId).toBe("sess-100");
  });
});
