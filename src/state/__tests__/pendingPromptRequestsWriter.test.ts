import { describe, it, expect, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PendingPromptRequestsWriter } from "../pendingPromptRequestsWriter.js";

const TEST_REGISTRY = join(tmpdir(), "hoop-pending-prompt-requests-test.json");

function makeWriter() {
  return new PendingPromptRequestsWriter(TEST_REGISTRY);
}

describe("PendingPromptRequestsWriter", () => {
  afterEach(() => {
    try { unlinkSync(TEST_REGISTRY); } catch { /* ignore */ }
  });

  it("writes the current pending requests", () => {
    const writer = makeWriter();
    writer.sync([
      {
        id: "req-1",
        prompt: "Fix the bug",
        requestedBy: "peer-1",
        status: "pending-approval",
        requestedAt: 1,
      },
      {
        id: "req-2",
        prompt: "Add feature",
        model: "sonnet",
        requestedBy: "peer-2",
        status: "approved",
        requestedAt: 2,
      },
    ]);

    const registry = PendingPromptRequestsWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.requests).toHaveLength(2);
    expect(registry!.requests[0]).toEqual({
      id: "req-1",
      prompt: "Fix the bug",
      requestedBy: "peer-1",
      status: "pending-approval",
      requestedAt: 1,
    });
    expect(registry!.requests[1]).toEqual({
      id: "req-2",
      prompt: "Add feature",
      model: "sonnet",
      requestedBy: "peer-2",
      status: "approved",
      requestedAt: 2,
    });
  });

  it("replaces old requests on sync", () => {
    const writer = makeWriter();
    writer.sync([
      {
        id: "req-1",
        prompt: "Old task",
        requestedBy: "peer-1",
        status: "pending-approval",
        requestedAt: 1,
      },
    ]);

    writer.sync([
      {
        id: "req-2",
        prompt: "New task",
        requestedBy: "peer-2",
        status: "approved",
        requestedAt: 2,
      },
    ]);

    const registry = PendingPromptRequestsWriter.readRegistry(TEST_REGISTRY);
    expect(registry!.requests).toEqual([
      {
        id: "req-2",
        prompt: "New task",
        requestedBy: "peer-2",
        status: "approved",
        requestedAt: 2,
      },
    ]);
  });

  it("clear empties the registry", () => {
    const writer = makeWriter();
    writer.sync([
      {
        id: "req-1",
        prompt: "Task",
        requestedBy: "peer-1",
        status: "pending-approval",
        requestedAt: 1,
      },
    ]);

    writer.clear();

    const registry = PendingPromptRequestsWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.requests).toEqual([]);
  });

  it("readRegistry returns null for missing file", () => {
    const registry = PendingPromptRequestsWriter.readRegistry(TEST_REGISTRY);
    expect(registry).toBeNull();
  });
});
