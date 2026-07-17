import { vi, describe, it, expect, beforeEach } from "vitest";

const startNewConversationMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    startNewConversation: (opts: any) => startNewConversationMock(opts),
  },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  startNewConversationMock.mockReset();
  mod = await import("./route");
});

describe("POST /api/sessions/new", () => {
  it("forwards cwd/label/name to the sandbox client", async () => {
    startNewConversationMock.mockResolvedValueOnce({
      sessionId: "pending-123",
      meta: { cwd: "/workspace", status: "alive" },
    });

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace", label: "L", name: "N" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: "pending-123",
      meta: { cwd: "/workspace", status: "alive" },
    });
    expect(startNewConversationMock).toHaveBeenCalledWith({
      cwd: "/workspace",
      label: "L",
      name: "N",
      model: undefined,
      via: "new-conversation",
    });
  });

  it("forwards model when provided", async () => {
    startNewConversationMock.mockResolvedValueOnce({
      sessionId: "pending-789",
      meta: { cwd: "/workspace", status: "alive" },
    });

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace", model: "opus" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(startNewConversationMock).toHaveBeenCalledWith({
      cwd: "/workspace",
      label: undefined,
      name: undefined,
      model: "opus",
      via: "new-conversation",
    });
  });

  it("omits cwd/label/name when absent from body", async () => {
    startNewConversationMock.mockResolvedValueOnce({
      sessionId: "pending-456",
      meta: { cwd: undefined, status: "alive" },
    });

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(startNewConversationMock).toHaveBeenCalledWith({
      cwd: undefined,
      label: undefined,
      name: undefined,
      model: undefined,
      via: "new-conversation",
    });
  });

  it("forwards sandbox 400s (e.g. cwd-not-allowed) as the same status", async () => {
    const err: any = new Error("cwd not allowed: /etc");
    err.status = 400;
    startNewConversationMock.mockRejectedValueOnce(err);

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/etc" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cwd not allowed: /etc" });
  });

  it("returns 500 when the sandbox client throws without a status", async () => {
    startNewConversationMock.mockRejectedValueOnce(new Error("spawn failed"));

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "spawn failed" });
  });
});
