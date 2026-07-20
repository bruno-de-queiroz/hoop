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

  describe("peer 'left' signal (marker source)", () => {
    function collectLefts() {
      const lefts: Array<{ sessionId?: string; participantId?: string; name?: string | null }> = [];
      mod.presenceBus().on("left", (p) => lefts.push(p as never));
      return lefts;
    }

    it("a beacon leave emits 'left' only AFTER the grace window", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      mod.leave("s1", "peer:x"); // tab-close beacon
      vi.advanceTimersByTime(11_000);
      expect(lefts).toHaveLength(0); // still inside the 12s grace
      vi.advanceTimersByTime(2_000);
      expect(lefts).toEqual([{ sessionId: "s1", participantId: "peer:x", name: "X" }]);
    });

    it("a heartbeat within the grace window cancels the 'left' (surviving second tab)", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      mod.leave("s1", "peer:x");
      vi.advanceTimersByTime(8_000);
      // Another tab under the SAME participantId is still beating.
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      vi.advanceTimersByTime(10_000); // past the original grace deadline
      expect(lefts).toHaveLength(0);
    });

    it("a peer that stops beating emits 'left' via the silent-drop watchdog", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      vi.advanceTimersByTime(41_000);
      expect(lefts).toHaveLength(0); // watchdog is TTL(30s)+grace(12s)=42s
      vi.advanceTimersByTime(2_000);
      expect(lefts).toHaveLength(1);
    });

    it("silent leave drops presence WITHOUT emitting 'left' (explicit-leave path)", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      mod.leave("s1", "peer:x", { silent: true });
      vi.advanceTimersByTime(60_000);
      expect(lefts).toHaveLength(0);
      expect(mod.listPresence("s1")).toHaveLength(0);
    });

    it("never emits 'left' for a host", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" });
      mod.leave("s1", "host");
      vi.advanceTimersByTime(60_000);
      expect(lefts).toHaveLength(0);
    });
  });
});
