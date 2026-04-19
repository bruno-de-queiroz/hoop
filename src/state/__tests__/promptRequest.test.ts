import { describe, it, expect } from "vitest";
import {
  isPromptRequest,
  isPromptResponse,
  isPromptRequestMessage,
  isPromptStatusQuery,
  PromptRequestQueue,
  type PromptRequest,
} from "../promptRequest.js";

// ── isPromptRequest ────────────────────────────────────────────────

describe("isPromptRequest", () => {
  it("accepts a valid request", () => {
    expect(
      isPromptRequest({
        id: "abc",
        prompt: "Fix the bug",
        requestedBy: "peer-1",
        timestamp: 123,
      }),
    ).toBe(true);
  });

  it("accepts a request with optional model", () => {
    expect(
      isPromptRequest({
        id: "abc",
        prompt: "Fix the bug",
        model: "sonnet",
        requestedBy: "peer-1",
        timestamp: 123,
      }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isPromptRequest(null)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isPromptRequest("string")).toBe(false);
  });

  it("rejects missing id", () => {
    expect(
      isPromptRequest({ prompt: "x", requestedBy: "p", timestamp: 1 }),
    ).toBe(false);
  });

  it("rejects missing prompt", () => {
    expect(
      isPromptRequest({ id: "x", requestedBy: "p", timestamp: 1 }),
    ).toBe(false);
  });

  it("rejects missing requestedBy", () => {
    expect(
      isPromptRequest({ id: "x", prompt: "x", timestamp: 1 }),
    ).toBe(false);
  });

  it("rejects missing timestamp", () => {
    expect(
      isPromptRequest({ id: "x", prompt: "x", requestedBy: "p" }),
    ).toBe(false);
  });

  it("rejects non-string model", () => {
    expect(
      isPromptRequest({
        id: "x",
        prompt: "x",
        requestedBy: "p",
        timestamp: 1,
        model: 42,
      }),
    ).toBe(false);
  });
});

// ── isPromptResponse ───────────────────────────────────────────────

describe("isPromptResponse", () => {
  it("accepts a valid response", () => {
    expect(
      isPromptResponse({ id: "abc", status: "approved", timestamp: 123 }),
    ).toBe(true);
  });

  it("accepts a response with error", () => {
    expect(
      isPromptResponse({
        id: "abc",
        status: "failed",
        error: "boom",
        timestamp: 123,
      }),
    ).toBe(true);
  });

  it("accepts a response with reason", () => {
    expect(
      isPromptResponse({
        id: "abc",
        status: "denied",
        reason: "not now",
        timestamp: 123,
      }),
    ).toBe(true);
  });

  it("rejects invalid status", () => {
    expect(
      isPromptResponse({ id: "abc", status: "unknown", timestamp: 123 }),
    ).toBe(false);
  });

  it("rejects null", () => {
    expect(isPromptResponse(null)).toBe(false);
  });

  it("rejects missing id", () => {
    expect(isPromptResponse({ status: "approved", timestamp: 1 })).toBe(false);
  });

  it("rejects non-string error", () => {
    expect(
      isPromptResponse({
        id: "x",
        status: "failed",
        error: 42,
        timestamp: 1,
      }),
    ).toBe(false);
  });

  it("rejects non-string reason", () => {
    expect(
      isPromptResponse({
        id: "x",
        status: "denied",
        reason: true,
        timestamp: 1,
      }),
    ).toBe(false);
  });

  it("accepts all valid statuses", () => {
    for (const status of [
      "pending-approval",
      "approved",
      "executing",
      "completed",
      "failed",
      "denied",
    ]) {
      expect(
        isPromptResponse({ id: "x", status, timestamp: 1 }),
      ).toBe(true);
    }
  });
});

// ── isPromptRequestMessage ─────────────────────────────────────────

describe("isPromptRequestMessage", () => {
  it("accepts a valid message", () => {
    expect(
      isPromptRequestMessage({
        type: "prompt-request",
        prompt: "Fix the bug",
        timestamp: 123,
      }),
    ).toBe(true);
  });

  it("accepts with optional model", () => {
    expect(
      isPromptRequestMessage({
        type: "prompt-request",
        prompt: "Fix",
        model: "sonnet",
        timestamp: 1,
      }),
    ).toBe(true);
  });

  it("rejects wrong type field", () => {
    expect(
      isPromptRequestMessage({
        type: "status-query",
        prompt: "Fix",
        timestamp: 1,
      }),
    ).toBe(false);
  });

  it("rejects missing prompt", () => {
    expect(
      isPromptRequestMessage({ type: "prompt-request", timestamp: 1 }),
    ).toBe(false);
  });

  it("rejects null", () => {
    expect(isPromptRequestMessage(null)).toBe(false);
  });
});

// ── isPromptStatusQuery ────────────────────────────────────────────

describe("isPromptStatusQuery", () => {
  it("accepts a valid query", () => {
    expect(
      isPromptStatusQuery({ type: "status-query", id: "req-1" }),
    ).toBe(true);
  });

  it("rejects wrong type", () => {
    expect(
      isPromptStatusQuery({ type: "prompt-request", id: "req-1" }),
    ).toBe(false);
  });

  it("rejects missing id", () => {
    expect(isPromptStatusQuery({ type: "status-query" })).toBe(false);
  });

  it("rejects null", () => {
    expect(isPromptStatusQuery(null)).toBe(false);
  });
});

// ── PromptRequestQueue ──────────────────────────────────────────────

function makeRequest(overrides?: Partial<PromptRequest>): PromptRequest {
  return {
    id: overrides?.id ?? "req-1",
    prompt: overrides?.prompt ?? "Do something",
    requestedBy: overrides?.requestedBy ?? "peer-1",
    timestamp: overrides?.timestamp ?? Date.now(),
    ...(overrides?.model ? { model: overrides.model } : {}),
  };
}

describe("PromptRequestQueue", () => {
  it("enqueue with autoExecute=false returns pending-approval", () => {
    const queue = new PromptRequestQueue();
    const response = queue.enqueue(makeRequest(), false);
    expect(response.status).toBe("pending-approval");
    expect(response.id).toBe("req-1");
    expect(queue.size()).toBe(1);
  });

  it("enqueue with autoExecute=true returns approved", () => {
    const queue = new PromptRequestQueue();
    const response = queue.enqueue(makeRequest(), true);
    expect(response.status).toBe("approved");
  });

  it("get returns the queued entry", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), false);
    const entry = queue.get("req-1");
    expect(entry).toBeDefined();
    expect(entry!.request.prompt).toBe("Do something");
    expect(entry!.status).toBe("pending-approval");
  });

  it("get returns undefined for unknown id", () => {
    const queue = new PromptRequestQueue();
    expect(queue.get("no-such")).toBeUndefined();
  });

  it("listActive returns pending-approval, approved, and executing entries", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest({ id: "a" }), false);
    queue.enqueue(makeRequest({ id: "b" }), true);
    const active = queue.listActive();
    expect(active).toHaveLength(2);
  });

  it("listActive excludes completed/failed/denied", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest({ id: "a" }), true);
    queue.complete("a");
    expect(queue.listActive()).toHaveLength(0);
  });

  // ── approve ──

  it("approve transitions pending-approval to approved", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), false);

    const response = queue.approve("req-1");
    expect(response).toBeDefined();
    expect(response!.status).toBe("approved");
    expect(queue.get("req-1")?.status).toBe("approved");
  });

  it("approve returns undefined for already-approved entry", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), true); // already approved
    expect(queue.approve("req-1")).toBeUndefined();
  });

  it("approve returns undefined for unknown id", () => {
    const queue = new PromptRequestQueue();
    expect(queue.approve("no-such")).toBeUndefined();
  });

  // ── deny ──

  it("deny transitions pending-approval to denied", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), false);

    const response = queue.deny("req-1", "not now");
    expect(response).toBeDefined();
    expect(response!.status).toBe("denied");
    expect(response!.reason).toBe("not now");
    expect(queue.get("req-1")?.status).toBe("denied");
  });

  it("deny returns undefined for approved entry", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), true);
    expect(queue.deny("req-1")).toBeUndefined();
  });

  // ── markExecuting ──

  it("markExecuting transitions approved to executing", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), true);
    expect(queue.markExecuting("req-1")).toBe(true);
    expect(queue.get("req-1")?.status).toBe("executing");
  });

  it("markExecuting returns false for pending-approval", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), false);
    expect(queue.markExecuting("req-1")).toBe(false);
  });

  it("markExecuting returns false for unknown id", () => {
    const queue = new PromptRequestQueue();
    expect(queue.markExecuting("no-such")).toBe(false);
  });

  // ── complete ──

  it("complete auto-transitions from approved through executing to completed", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), true);

    const response = queue.complete("req-1");
    expect(response!.status).toBe("completed");
    expect(queue.get("req-1")?.status).toBe("completed");
  });

  it("complete from executing returns completed", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), true);
    queue.markExecuting("req-1");
    const response = queue.complete("req-1");
    expect(response!.status).toBe("completed");
  });

  it("complete with error returns failed", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), true);
    const response = queue.complete("req-1", "something broke");
    expect(response!.status).toBe("failed");
    expect(response!.error).toBe("something broke");
  });

  it("complete returns undefined for pending-approval", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), false);
    expect(queue.complete("req-1")).toBeUndefined();
  });

  it("complete returns undefined for unknown id", () => {
    const queue = new PromptRequestQueue();
    expect(queue.complete("no-such")).toBeUndefined();
  });

  it("complete returns undefined for denied entry", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), false);
    queue.deny("req-1");
    expect(queue.complete("req-1")).toBeUndefined();
  });

  // ── terminal entries stay in queue ──

  it("denied entries remain queryable", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), false);
    queue.deny("req-1", "no");
    expect(queue.get("req-1")?.status).toBe("denied");
    expect(queue.size()).toBe(1);
  });

  it("completed entries remain queryable", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), true);
    queue.complete("req-1");
    expect(queue.get("req-1")?.status).toBe("completed");
    expect(queue.size()).toBe(1);
  });

  // ── clear / size ──

  it("clear removes all entries", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest({ id: "a" }), false);
    queue.enqueue(makeRequest({ id: "b" }), true);
    expect(queue.size()).toBe(2);
    queue.clear();
    expect(queue.size()).toBe(0);
  });
});
