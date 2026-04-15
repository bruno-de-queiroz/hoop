import { describe, it, expect, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PendingAdmissionsWriter } from "../pendingAdmissionsWriter.js";

const TEST_REGISTRY = join(tmpdir(), "hoop-pending-admissions-test.json");

function makeWriter() {
  return new PendingAdmissionsWriter(TEST_REGISTRY);
}

describe("PendingAdmissionsWriter", () => {
  afterEach(() => {
    try { unlinkSync(TEST_REGISTRY); } catch { /* ignore */ }
  });

  it("writes the current pending requests", () => {
    const writer = makeWriter();
    writer.sync([
      {
        email: "alice@example.com",
        peerId: "peer-alice",
        requestedAt: 1,
      },
      {
        email: "bob@example.com",
        peerId: "peer-bob",
        requestedAt: 2,
      },
    ]);

    const registry = PendingAdmissionsWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.requests).toHaveLength(2);
    expect(registry!.requests[0]).toEqual({
      email: "alice@example.com",
      peerId: "peer-alice",
      requestedAt: 1,
    });
    expect(registry!.requests[1]).toEqual({
      email: "bob@example.com",
      peerId: "peer-bob",
      requestedAt: 2,
    });
  });

  it("replaces old requests on sync", () => {
    const writer = makeWriter();
    writer.sync([
      {
        email: "alice@example.com",
        peerId: "peer-alice",
        requestedAt: 1,
      },
    ]);

    writer.sync([
      {
        email: "carol@example.com",
        peerId: "peer-carol",
        requestedAt: 3,
      },
    ]);

    const registry = PendingAdmissionsWriter.readRegistry(TEST_REGISTRY);
    expect(registry!.requests).toEqual([
      {
        email: "carol@example.com",
        peerId: "peer-carol",
        requestedAt: 3,
      },
    ]);
  });

  it("clear empties the registry", () => {
    const writer = makeWriter();
    writer.sync([
      {
        email: "alice@example.com",
        peerId: "peer-alice",
        requestedAt: 1,
      },
    ]);

    writer.clear();

    const registry = PendingAdmissionsWriter.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.requests).toEqual([]);
  });

  it("readRegistry returns null for missing file", () => {
    const registry = PendingAdmissionsWriter.readRegistry(TEST_REGISTRY);
    expect(registry).toBeNull();
  });
});
