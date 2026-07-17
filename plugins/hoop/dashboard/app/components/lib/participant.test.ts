import { describe, it, expect, afterEach } from "vitest";
import { peerCapability, canDecidePlans, myDisplayName, stashHostName, stashPeerName } from "./participant";

// The client reads identity from layout-injected <meta> tags. These tests drive
// the plan-decision gate: who may Approve/Reject a plan review.
function setMeta(name: string, content: string) {
  const m = document.createElement("meta");
  m.setAttribute("name", name);
  m.setAttribute("content", content);
  document.head.appendChild(m);
}

afterEach(() => {
  document.head.querySelectorAll("meta[name^='x-hoop-']").forEach((m) => m.remove());
  try { sessionStorage.clear(); } catch { /* ignore */ }
});

describe("display names", () => {
  it("host advertises 'Host' until the identity loads, then the first name", () => {
    expect(myDisplayName()).toBe("Host"); // no participant meta ⇒ host
    stashHostName("Bruno de Queiroz");
    expect(myDisplayName()).toBe("Bruno"); // first token only
  });

  it("a peer advertises the name they picked at join", () => {
    setMeta("x-hoop-participant", "peer");
    expect(myDisplayName()).toBe("Guest"); // nothing stashed yet
    stashPeerName("Alex");
    expect(myDisplayName()).toBe("Alex");
  });
});

describe("participant plan-decision gate", () => {
  it("host (no participant meta) may decide", () => {
    expect(canDecidePlans()).toBe(true);
    expect(peerCapability()).toBeNull();
  });

  it("a full-capability peer may decide", () => {
    setMeta("x-hoop-participant", "peer");
    setMeta("x-hoop-peer-capability", "full");
    expect(peerCapability()).toBe("full");
    expect(canDecidePlans()).toBe(true);
  });

  it("a drive peer may NOT decide (comment-only)", () => {
    setMeta("x-hoop-participant", "peer");
    setMeta("x-hoop-peer-capability", "drive");
    expect(peerCapability()).toBe("drive");
    expect(canDecidePlans()).toBe(false);
  });

  it("a spectate peer may NOT decide", () => {
    setMeta("x-hoop-participant", "peer");
    setMeta("x-hoop-peer-capability", "spectate");
    expect(canDecidePlans()).toBe(false);
  });

  it("a peer with a missing/garbled capability may NOT decide (fail closed)", () => {
    setMeta("x-hoop-participant", "peer");
    expect(peerCapability()).toBeNull();
    expect(canDecidePlans()).toBe(false);
  });
});
