import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFromStream, ReadFromStreamOptions } from "../protocol.js";
import type { Stream } from "@libp2p/interface";

// Create a mock stream from an async iterable
function createMockStream(chunks: (Uint8Array | Buffer)[]): Stream {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as Stream;
}

describe("readFromStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a small valid JSON message and returns parsed value", async () => {
    const message = { type: "test", data: 42 };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(message));
    const stream = createMockStream([jsonBytes]);

    const result = await readFromStream<typeof message>(stream);

    expect(result).toEqual(message);
  });

  it("throws when message exceeds maxBytes limit", async () => {
    // Create a stream generator that yields chunks exceeding limit quickly
    async function* largeStream() {
      yield new Uint8Array(60);
      yield new Uint8Array(60); // Total 120 bytes exceeds 100 byte limit
    }

    const stream = {
      [Symbol.asyncIterator]: largeStream,
    } as unknown as Stream;

    const promise = readFromStream(stream, { maxBytes: 100, idleTimeoutMs: 10000 });
    await expect(promise).rejects.toThrow("Message exceeds max size of 100 bytes");
  });

  it("throws when stream stalls longer than idleTimeoutMs", async () => {
    // Create a stream that yields a chunk and never finishes
    async function* stallingStream() {
      yield new TextEncoder().encode("{}"); // Valid JSON but stream never closes
      // Stalled—no more chunks coming
      await new Promise(() => {}); // Never resolves
    }

    const stream = {
      [Symbol.asyncIterator]: stallingStream,
    } as unknown as Stream;

    const promise = readFromStream(stream, { idleTimeoutMs: 500 });

    // Advance timers past the idle timeout
    vi.advanceTimersByTime(600);

    await expect(promise).rejects.toThrow("Read timed out after 500ms");
  });

  it("respects custom maxBytes option", async () => {
    const chunk1 = new TextEncoder().encode('{"a":');
    const chunk2 = new TextEncoder().encode('"b"}'); // 10 bytes total
    const stream = createMockStream([chunk1, chunk2]);

    const result = await readFromStream<{ a: string }>(stream, {
      maxBytes: 20,
    });

    expect(result).toEqual({ a: "b" });
  });

  it("respects custom idleTimeoutMs option", async () => {
    // Create a stream that stalls after first chunk
    async function* slowStream() {
      yield new TextEncoder().encode("{}");
      // Stall indefinitely
      await new Promise(() => {});
    }

    const stream = {
      [Symbol.asyncIterator]: slowStream,
    } as unknown as Stream;

    const promise = readFromStream(stream, { idleTimeoutMs: 1000 });

    vi.advanceTimersByTime(1100);

    await expect(promise).rejects.toThrow("Read timed out after 1000ms");
  });

  it("clears timeout on successful completion", async () => {
    const message = { complete: true };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(message));
    const stream = createMockStream([jsonBytes]);

    await readFromStream<typeof message>(stream);

    // After successful read, no pending timers should remain
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles multiple chunks below maxBytes", async () => {
    const chunks = [
      new TextEncoder().encode('{"items":['),
      new TextEncoder().encode('1,'),
      new TextEncoder().encode('2,'),
      new TextEncoder().encode('3]}'),
    ];
    const stream = createMockStream(chunks);

    const result = await readFromStream<{ items: number[] }>(stream);

    expect(result).toEqual({ items: [1, 2, 3] });
  });
});
