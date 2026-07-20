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

  it("evicts a participant only past the long eviction window, not the idle window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" });
    expect(mod.listPresence("s1")).toHaveLength(1);
    // Still present well past the (short) idle/dim window.
    vi.setSystemTime(31_000);
    expect(mod.listPresence("s1")).toHaveLength(1);
    // Evicted only past the long window (GONE_MS = 3 min).
    vi.setSystemTime(3 * 60_000 + 1_000);
    expect(mod.listPresence("s1")).toHaveLength(0);
  });

  describe("away (dim) — NOT a departure", () => {
    it("a peer reporting its tab inactive is marked away, not removed, no marker", () => {
      const lefts: unknown[] = [];
      mod.presenceBus().on("left", (p) => lefts.push(p));
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer", active: false });
      const list = mod.listPresence("s1");
      expect(list).toHaveLength(1);
      expect(list[0].away).toBe(true);
      expect(lefts).toHaveLength(0);
    });

    it("an active peer is not away; goes away once its heartbeat is stale", () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      expect(mod.listPresence("s1")[0].away).toBe(false);
      // Past the idle window (25s) but nowhere near GONE — dimmed, still here.
      vi.setSystemTime(26_000);
      const list = mod.listPresence("s1");
      expect(list).toHaveLength(1);
      expect(list[0].away).toBe(true);
    });

    it("hosts are never marked away", () => {
      mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host", active: false });
      expect(mod.listPresence("s1")[0].away).toBe(false);
    });
  });

  describe("peer 'left' signal (marker source)", () => {
    function collectLefts() {
      const lefts: Array<{ sessionId?: string; participantId?: string; name?: string | null }> = [];
      mod.presenceBus().on("left", (p) => lefts.push(p as never));
      return lefts;
    }

    it("does NOT emit 'left' for a merely backgrounded peer (the bug: no 42s drop)", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer", active: false });
      // Well past the old TTL+grace (42s) — must stay (dimmed), not leave.
      vi.advanceTimersByTime(60_000);
      expect(lefts).toHaveLength(0);
      expect(mod.listPresence("s1")).toHaveLength(1);
    });

    it("emits 'left' only after GONE_MS of inactivity", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      vi.advanceTimersByTime(3 * 60_000 - 1_000);
      expect(lefts).toHaveLength(0);
      vi.advanceTimersByTime(2_000);
      expect(lefts).toEqual([{ sessionId: "s1", participantId: "peer:x", name: "X" }]);
    });

    it("an active beat pushes the gone-timer out (peer came back to the foreground)", () => {
      vi.useFakeTimers(); // t=0
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" }); // arm fire@180s
      // Background beats in between don't reset the countdown…
      vi.advanceTimersByTime(60_000); // t=60s
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer", active: false });
      // …but a foreground beat does — re-arms fire@ t=120s+180s=300s.
      vi.advanceTimersByTime(60_000); // t=120s
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer", active: true });
      // Past the ORIGINAL deadline (180s) → still here, because it was re-armed.
      vi.advanceTimersByTime(61_000); // t=181s
      expect(lefts).toHaveLength(0);
      // Past the NEW deadline (300s).
      vi.advanceTimersByTime(3 * 60_000); // t=361s
      expect(lefts).toHaveLength(1);
    });

    it("silent leave drops presence WITHOUT emitting 'left' (explicit-leave path)", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      mod.leave("s1", "peer:x", { silent: true });
      vi.advanceTimersByTime(5 * 60_000);
      expect(lefts).toHaveLength(0);
      expect(mod.listPresence("s1")).toHaveLength(0);
    });

    it("a beacon leave drops the roster entry but the gone-watchdog still resolves to 'left'", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      mod.leave("s1", "peer:x"); // tab-close beacon — roster only
      expect(mod.listPresence("s1")).toHaveLength(0);
      vi.advanceTimersByTime(3 * 60_000 + 1_000);
      expect(lefts).toEqual([{ sessionId: "s1", participantId: "peer:x", name: "X" }]);
    });

    it("never emits 'left' for a host", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" });
      mod.leave("s1", "host");
      vi.advanceTimersByTime(5 * 60_000);
      expect(lefts).toHaveLength(0);
    });
  });
});
