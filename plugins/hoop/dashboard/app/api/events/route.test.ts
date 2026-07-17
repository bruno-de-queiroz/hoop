import { vi, describe, it, expect, beforeEach } from "vitest";

const listEventsMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    listEvents: (opts: unknown) => listEventsMock(opts),
  },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  listEventsMock.mockReset();
  listEventsMock.mockResolvedValue([]);
  mod = await import("./route");
});

function makeReq(search: string): Request {
  return new Request(`http://localhost/api/events${search}`);
}

describe("GET /api/events — limit clamping", () => {
  it("uses default limit of 200 when no limit param is given", async () => {
    const res = await mod.GET(makeReq(""));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 })
    );
  });

  it("clamps limit=-1 to 1 (prevents SQLite LIMIT -1 full-table scan)", async () => {
    const res = await mod.GET(makeReq("?limit=-1"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 })
    );
  });

  it("clamps limit=0 to 1", async () => {
    const res = await mod.GET(makeReq("?limit=0"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 })
    );
  });

  it("clamps limit=99999 to max (1000)", async () => {
    const res = await mod.GET(makeReq("?limit=99999"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000 })
    );
  });

  it("passes through a valid limit unchanged", async () => {
    const res = await mod.GET(makeReq("?limit=50"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 })
    );
  });

  it("falls back to 200 when limit is a non-numeric string", async () => {
    const res = await mod.GET(makeReq("?limit=abc"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 })
    );
  });

  it("passes optional filter params through to the client", async () => {
    const res = await mod.GET(makeReq("?limit=10&hook=PreToolUse&session=s1"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, hook: "PreToolUse", session: "s1" })
    );
  });
});
