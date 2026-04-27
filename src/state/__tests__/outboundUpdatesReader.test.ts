import { describe, it, expect, vi } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OutboundUpdatesReader,
  type OutboundUpdate,
} from "../outboundUpdatesReader.js";

const TEST_REGISTRY = join(tmpdir(), "hoop-outbound-updates-test.json");

/** Each watcher-based test gets its own path to avoid watchFile interference. */
let pathCounter = 0;
function uniqueRegistryPath(): string {
  return join(tmpdir(), `hoop-outbound-test-${++pathCounter}-${Date.now()}.json`);
}

function writeOutbound(path: string, updates: OutboundUpdate[]): void {
  writeFileSync(
    path,
    JSON.stringify({ updates, updatedAt: Date.now() }),
    "utf-8",
  );
}

function makeUpdate(filePath: string, patch: string): OutboundUpdate {
  return {
    filePath,
    patch,
    baseHash: "aaa",
    resultHash: "bbb",
    timestamp: Date.now(),
  };
}

function cleanup(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}

describe("OutboundUpdatesReader", () => {
  it("readRegistry returns null for missing file", () => {
    const result = OutboundUpdatesReader.readRegistry(TEST_REGISTRY);
    expect(result).toBeNull();
  });

  it("readRegistry reads updates from file", () => {
    const update = makeUpdate("src/main.ts", "+new line");
    writeOutbound(TEST_REGISTRY, [update]);

    const registry = OutboundUpdatesReader.readRegistry(TEST_REGISTRY);
    expect(registry).not.toBeNull();
    expect(registry!.updates).toHaveLength(1);
    expect(registry!.updates[0].filePath).toBe("src/main.ts");
    expect(registry!.updates[0].patch).toBe("+new line");

    cleanup(TEST_REGISTRY);
  });

  it("start initializes an empty file", () => {
    const path = uniqueRegistryPath();
    const onUpdate = vi.fn();
    const reader = new OutboundUpdatesReader(onUpdate, path);
    reader.start();

    const registry = OutboundUpdatesReader.readRegistry(path);
    expect(registry).not.toBeNull();
    expect(registry!.updates).toHaveLength(0);

    reader.stop();
    cleanup(path);
  });

  it("drains updates and calls callback on file change", async () => {
    const path = uniqueRegistryPath();
    const received: OutboundUpdate[] = [];
    const reader = new OutboundUpdatesReader(
      (update) => received.push(update),
      path,
    );
    reader.start();

    // Small delay to let fs.watch attach
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Write updates to the outbound file
    writeOutbound(path, [
      makeUpdate("src/main.ts", "+line 1"),
      makeUpdate("src/utils.ts", "+line 2"),
    ]);

    // fs.watch fires asynchronously; reader debounces 25ms then drains
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(received).toHaveLength(2);
    expect(received[0].filePath).toBe("src/main.ts");
    expect(received[1].filePath).toBe("src/utils.ts");

    // File should be cleared after drain
    const registry = OutboundUpdatesReader.readRegistry(path);
    expect(registry!.updates).toHaveLength(0);

    reader.stop();
    cleanup(path);
  });

  it("does not call callback for empty updates", async () => {
    const path = uniqueRegistryPath();
    const onUpdate = vi.fn();
    const reader = new OutboundUpdatesReader(onUpdate, path);
    reader.start();

    // Write empty updates
    writeOutbound(path, []);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(onUpdate).not.toHaveBeenCalled();

    reader.stop();
    cleanup(path);
  });

  it("handles callback errors without blocking other updates", async () => {
    const path = uniqueRegistryPath();
    let callCount = 0;
    const reader = new OutboundUpdatesReader(
      (update) => {
        callCount++;
        if (update.filePath === "src/bad.ts") {
          throw new Error("callback failure");
        }
      },
      path,
    );
    reader.start();

    // Small delay to let watchFile record the initial stat before writing
    await new Promise((resolve) => setTimeout(resolve, 100));

    writeOutbound(path, [
      makeUpdate("src/bad.ts", "+error"),
      makeUpdate("src/good.ts", "+ok"),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(callCount).toBe(2);

    reader.stop();
    cleanup(path);
  });

  it("stop prevents further processing", async () => {
    const path = uniqueRegistryPath();
    const onUpdate = vi.fn();
    const reader = new OutboundUpdatesReader(onUpdate, path);
    reader.start();
    reader.stop();

    writeOutbound(path, [makeUpdate("src/main.ts", "+line")]);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(onUpdate).not.toHaveBeenCalled();

    cleanup(path);
  });
});
