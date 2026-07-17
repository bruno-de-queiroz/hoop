import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

describe("presence registry", () => {
  let mod: typeof import("./presence");

  beforeEach(async () => {
    // Fresh globalThis singleton per test.
    delete (globalThis as any).__hoop_presence__;
    vi.resetModules();
    mod = await import("./presence");
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).__hoop_presence__;
  });

  it("tracks participants per session and dedupes by participantId", () => {
    mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" });
    mod.heartbeat({ sessionId: "s1", participantId: "peer:abc", name: "Bob", kind: "peer", typing: true });
    mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" }); // refresh

    const list = mod.listPresence("s1");
    expect(list).toHaveLength(2);
    const bob = list.find((p) => p.participantId === "peer:abc");
    expect(bob?.name).toBe("Bob");
    expect(bob?.typing).toBe(true);
  });

  it("isolates sessions", () => {
    mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" });
    mod.heartbeat({ sessionId: "s2", participantId: "host", name: "Host", kind: "host" });
    expect(mod.listPresence("s1")).toHaveLength(1);
    expect(mod.listPresence("s2")).toHaveLength(1);
    expect(mod.listPresence("nope")).toHaveLength(0);
  });

  it("leave() drops a participant and emits change", () => {
    let changes = 0;
    mod.presenceBus().on("change", () => { changes += 1; });
    mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
    mod.leave("s1", "peer:x");
    expect(mod.listPresence("s1")).toHaveLength(0);
    expect(changes).toBe(2); // heartbeat + leave
  });

  it("evicts stale participants past the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
    expect(mod.listPresence("s1")).toHaveLength(1);
    // Advance beyond the 30s heartbeat TTL.
    vi.setSystemTime(31_000);
    expect(mod.listPresence("s1")).toHaveLength(0);
  });
});
