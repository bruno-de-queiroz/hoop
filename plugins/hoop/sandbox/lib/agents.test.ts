import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./db", () => ({
  getDb: () => mockDb,
}));
vi.mock("./sessions", () => ({
  listSessions: () => mockSessions,
}));

let mockDb: any;
let mockSessions: any[];

beforeEach(() => {
  mockSessions = [];
  mockDb = {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
    })),
  };
});

import { listAgentRuns } from "./agents";

describe("listAgentRuns", () => {
  it("returns empty array when no events", () => {
    mockDb.prepare.mockReturnValue({ all: vi.fn(() => []) });
    const runs = listAgentRuns();
    expect(runs).toEqual([]);
  });

  it("creates completed run from Pre + Post pair", () => {
    const preTs = "2026-05-12T10:00:00Z";
    const postTs = "2026-05-12T10:00:05Z";
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: preTs,
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: {
              tool_input: { subagent_type: "claude-code", prompt: "do something" },
            },
          }),
        },
        {
          id: 2,
          ts: postTs,
          session_id: "session-1",
          hook_type: "PostToolUse",
          payload: JSON.stringify({
            ctx: {
              tool_response: {
                content: [{ type: "text", text: "done" }],
                usage: { model: "claude-opus-4-1" },
              },
            },
          }),
        },
      ]),
    });

    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 1,
      sessionId: "session-1",
      subagentType: "claude-code",
      prompt: "do something",
      startTs: preTs,
      endTs: postTs,
      status: "completed",
      result: "done",
      model: "claude-opus-4-1",
    });
    expect(runs[0].durationMs).toBe(5000);
  });

  it("marks Pre without Post as running when session is alive", () => {
    const preTs = "2026-05-12T10:00:00Z";
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: preTs,
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: { subagent_type: "agent" } },
          }),
        },
      ]),
    });
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 1,
      status: "running",
      endTs: null,
      durationMs: null,
    });
  });

  it("marks Pre as interrupted when session is not alive and > 5min old", () => {
    const oldTs = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: oldTs,
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: { subagent_type: "agent" } },
          }),
        },
      ]),
    });
    mockSessions = []; // session not alive

    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("interrupted");
    expect(runs[0].durationMs).toBeGreaterThan(6 * 60 * 1000 - 100);
  });

  it("keeps Pre as running when session not alive but < 5min old (grace period)", () => {
    const recentTs = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: recentTs,
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: { subagent_type: "agent" } },
          }),
        },
      ]),
    });
    mockSessions = []; // not alive

    const runs = listAgentRuns();
    expect(runs[0].status).toBe("running");
    expect(runs[0].durationMs).toBeNull();
  });

  it("handles nested agents with correct parentAgentId", () => {
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: "2026-05-12T10:00:00Z",
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: { subagent_type: "parent" } },
          }),
        },
        {
          id: 2,
          ts: "2026-05-12T10:00:01Z",
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: { subagent_type: "child" } },
          }),
        },
        {
          id: 3,
          ts: "2026-05-12T10:00:02Z",
          session_id: "session-1",
          hook_type: "PostToolUse",
          payload: JSON.stringify({
            ctx: { tool_response: {} },
          }),
        },
        {
          id: 4,
          ts: "2026-05-12T10:00:03Z",
          session_id: "session-1",
          hook_type: "PostToolUse",
          payload: JSON.stringify({
            ctx: { tool_response: {} },
          }),
        },
      ]),
    });
    mockSessions = [];

    const runs = listAgentRuns();
    const parent = runs.find((r) => r.id === 1);
    const child = runs.find((r) => r.id === 2);

    expect(parent).toMatchObject({ parentAgentId: null });
    expect(child).toMatchObject({ parentAgentId: 1 });
  });

  it("extracts text from content array with {type:text, text:...}", () => {
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: "2026-05-12T10:00:00Z",
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: {} },
          }),
        },
        {
          id: 2,
          ts: "2026-05-12T10:00:01Z",
          session_id: "session-1",
          hook_type: "PostToolUse",
          payload: JSON.stringify({
            ctx: {
              tool_response: {
                content: [
                  { type: "text", text: "hello" },
                  { type: "text", text: "world" },
                ],
              },
            },
          }),
        },
      ]),
    });

    const runs = listAgentRuns();
    expect(runs[0].result).toBe("hello\nworld");
  });

  it("extracts model from tool_response.usage.model", () => {
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: "2026-05-12T10:00:00Z",
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: {} },
          }),
        },
        {
          id: 2,
          ts: "2026-05-12T10:00:01Z",
          session_id: "session-1",
          hook_type: "PostToolUse",
          payload: JSON.stringify({
            ctx: {
              tool_response: {
                content: "ok",
                usage: { model: "claude-haiku-4-5" },
              },
            },
          }),
        },
      ]),
    });

    const runs = listAgentRuns();
    expect(runs[0].model).toBe("claude-haiku-4-5");
  });

  it("extracts toolUseCount from tool_response.usage.tool_use_count", () => {
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: "2026-05-12T10:00:00Z",
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: {} },
          }),
        },
        {
          id: 2,
          ts: "2026-05-12T10:00:01Z",
          session_id: "session-1",
          hook_type: "PostToolUse",
          payload: JSON.stringify({
            ctx: {
              tool_response: {
                content: "result",
                usage: { tool_use_count: 3 },
              },
            },
          }),
        },
      ]),
    });

    const runs = listAgentRuns();
    expect(runs[0].toolUseCount).toBe(3);
  });

  it("respects limit parameter (50 by default, last 50 by id desc)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      ts: `2026-05-12T10:${String(i).padStart(2, "0")}:00Z`,
      session_id: "session-1",
      hook_type: "PreToolUse",
      payload: JSON.stringify({
        ctx: { tool_input: {} },
      }),
    }));

    mockDb.prepare.mockReturnValue({ all: vi.fn(() => rows) });
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    const runs = listAgentRuns(5);
    expect(runs).toHaveLength(5);
    // Sorted by id descending
    expect(runs[0].id).toBe(10);
    expect(runs[4].id).toBe(6);
  });

  it("handles malformed JSON in payload gracefully", () => {
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: "2026-05-12T10:00:00Z",
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: "not json",
        },
        {
          id: 2,
          ts: "2026-05-12T10:00:01Z",
          session_id: "session-1",
          hook_type: "PostToolUse",
          payload: "bad json",
        },
      ]),
    });

    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 1,
      subagentType: null,
      prompt: null,
      result: null,
      status: "completed",
    });
  });

  it("handles null session_id (ambient cli session)", () => {
    const preTs = "2026-05-12T10:00:00Z";
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: preTs,
          session_id: null,
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: { subagent_type: "agent" } },
          }),
        },
      ]),
    });
    mockSessions = [];

    const runs = listAgentRuns();
    expect(runs[0].sessionId).toBeNull();
  });

  it("uses tool_result as fallback when tool_response missing", () => {
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          id: 1,
          ts: "2026-05-12T10:00:00Z",
          session_id: "session-1",
          hook_type: "PreToolUse",
          payload: JSON.stringify({
            ctx: { tool_input: {} },
          }),
        },
        {
          id: 2,
          ts: "2026-05-12T10:00:01Z",
          session_id: "session-1",
          hook_type: "PostToolUse",
          payload: JSON.stringify({
            ctx: {
              tool_result: {
                text: "fallback result",
              },
            },
          }),
        },
      ]),
    });

    const runs = listAgentRuns();
    expect(runs[0].result).toBe("fallback result");
  });
});
