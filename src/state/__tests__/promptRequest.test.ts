import { describe, it, expect } from "vitest";
import {
  isPromptRequest,
  isPromptResponse,
  PromptRequestQueue,
  type PromptRequest,
  type PromptResponse,
} from "../promptRequest.js";

// ── Validation guards ──────────────────────────────────────────────

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
    const resolve = () => {};
    const response = queue.enqueue(makeRequest(), resolve, false);
    expect(response.status).toBe("pending-approval");
    expect(response.id).toBe("req-1");
    expect(queue.size()).toBe(1);
  });

  it("enqueue with autoExecute=true returns approved", () => {
    const queue = new PromptRequestQueue();
    const resolve = () => {};
    const response = queue.enqueue(makeRequest(), resolve, true);
    expect(response.status).toBe("approved");
  });

  it("get returns the queued entry", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), () => {}, false);
    const entry = queue.get("req-1");
    expect(entry).toBeDefined();
    expect(entry!.request.prompt).toBe("Do something");
    expect(entry!.status).toBe("pending-approval");
  });

  it("get returns undefined for unknown id", () => {
    const queue = new PromptRequestQueue();
    expect(queue.get("no-such")).toBeUndefined();
  });

  it("getStatus returns the current status", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), () => {}, false);
    expect(queue.getStatus("req-1")).toBe("pending-approval");
  });

  it("getStatus returns undefined for unknown id", () => {
    const queue = new PromptRequestQueue();
    expect(queue.getStatus("no-such")).toBeUndefined();
  });

  it("listPending returns pending-approval and approved entries", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest({ id: "a" }), () => {}, false);
    queue.enqueue(makeRequest({ id: "b" }), () => {}, true);
    const pending = queue.listPending();
    expect(pending).toHaveLength(2);
  });

  it("listPending excludes executing/completed/failed/denied", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest({ id: "a" }), () => {}, true);
    queue.markExecuting("a");
    expect(queue.listPending()).toHaveLength(0);
  });

  // ── approve ──

  it("approve transitions pending-approval to approved", () => {
    const queue = new PromptRequestQueue();
    let resolved: PromptResponse | undefined;
    queue.enqueue(makeRequest(), (r) => { resolved = r; }, false);

    const response = queue.approve("req-1");
    expect(response).toBeDefined();
    expect(response!.status).toBe("approved");
    expect(resolved).toBeDefined();
    expect(resolved!.status).toBe("approved");
    expect(queue.getStatus("req-1")).toBe("approved");
  });

  it("approve returns undefined for already-approved entry", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), () => {}, true); // already approved
    expect(queue.approve("req-1")).toBeUndefined();
  });

  it("approve returns undefined for unknown id", () => {
    const queue = new PromptRequestQueue();
    expect(queue.approve("no-such")).toBeUndefined();
  });

  // ── deny ──

  it("deny transitions pending-approval to denied and removes entry", () => {
    const queue = new PromptRequestQueue();
    let resolved: PromptResponse | undefined;
    queue.enqueue(makeRequest(), (r) => { resolved = r; }, false);

    const response = queue.deny("req-1", "not now");
    expect(response).toBeDefined();
    expect(response!.status).toBe("denied");
    expect(response!.reason).toBe("not now");
    expect(resolved!.status).toBe("denied");
    expect(queue.size()).toBe(0);
  });

  it("deny returns undefined for approved entry", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), () => {}, true);
    expect(queue.deny("req-1")).toBeUndefined();
  });

  // ── markExecuting ──

  it("markExecuting transitions approved to executing", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), () => {}, true);
    expect(queue.markExecuting("req-1")).toBe(true);
    expect(queue.getStatus("req-1")).toBe("executing");
  });

  it("markExecuting returns false for pending-approval", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), () => {}, false);
    expect(queue.markExecuting("req-1")).toBe(false);
  });

  it("markExecuting returns false for unknown id", () => {
    const queue = new PromptRequestQueue();
    expect(queue.markExecuting("no-such")).toBe(false);
  });

  // ── complete ──

  it("complete from approved returns completed and removes entry", () => {
    const queue = new PromptRequestQueue();
    let resolved: PromptResponse | undefined;
    queue.enqueue(makeRequest(), (r) => { resolved = r; }, true);

    const response = queue.complete("req-1");
    expect(response!.status).toBe("completed");
    expect(resolved!.status).toBe("completed");
    expect(queue.size()).toBe(0);
  });

  it("complete from executing returns completed", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), () => {}, true);
    queue.markExecuting("req-1");
    const response = queue.complete("req-1");
    expect(response!.status).toBe("completed");
  });

  it("complete with error returns failed", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), () => {}, true);
    const response = queue.complete("req-1", "something broke");
    expect(response!.status).toBe("failed");
    expect(response!.error).toBe("something broke");
  });

  it("complete returns undefined for pending-approval", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest(), () => {}, false);
    expect(queue.complete("req-1")).toBeUndefined();
  });

  it("complete returns undefined for unknown id", () => {
    const queue = new PromptRequestQueue();
    expect(queue.complete("no-such")).toBeUndefined();
  });

  // ── clear / size ──

  it("clear removes all entries", () => {
    const queue = new PromptRequestQueue();
    queue.enqueue(makeRequest({ id: "a" }), () => {}, false);
    queue.enqueue(makeRequest({ id: "b" }), () => {}, true);
    expect(queue.size()).toBe(2);
    queue.clear();
    expect(queue.size()).toBe(0);
  });
});
