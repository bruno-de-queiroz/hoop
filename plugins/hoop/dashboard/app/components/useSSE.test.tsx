import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// The live channel is a WebSocket carrying `{ type, data }` JSON frames. This
// mock lets each test fire frames and assert the shared-socket / fan-out
// behaviour without a real server.
interface MockWSInstance {
  url: string;
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  close: ReturnType<typeof vi.fn>;
  fire(type: string, data: unknown): void;
}

const created: MockWSInstance[] = [];

class MockWebSocket implements MockWSInstance {
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  close: ReturnType<typeof vi.fn>;

  constructor(url: string) {
    this.url = url;
    this.close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED; });
    created.push(this);
    // Fire open asynchronously-ish (synchronous is fine for these tests).
    queueMicrotask(() => this.onopen?.({}));
  }

  fire(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}

beforeEach(() => {
  created.length = 0;
  vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSSE (shared WebSocket live channel)", () => {
  it("opens exactly ONE WebSocket regardless of how many components subscribe", async () => {
    const { useSSE } = await import("./useSSE");
    renderHook(() => useSSE({ sessions: () => {} }));
    renderHook(() => useSSE({ event: () => {} }));
    renderHook(() => useSSE({ sessions: () => {}, run: () => {} }));
    expect(created).toHaveLength(1);
    expect(created[0].url).toContain("/api/ws");
  });

  it("fans out a single frame to ALL subscribers for that type", async () => {
    const { useSSE } = await import("./useSSE");
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() => useSSE({ sessions: a }));
    renderHook(() => useSSE({ sessions: b }));

    act(() => { created[0].fire("sessions", { changed: true }); });
    expect(a).toHaveBeenCalledWith({ changed: true });
    expect(b).toHaveBeenCalledWith({ changed: true });
  });

  it("delivers frames to the correct type only", async () => {
    const { useSSE } = await import("./useSSE");
    const onSessions = vi.fn();
    const onEvent = vi.fn();
    renderHook(() => useSSE({ sessions: onSessions, event: onEvent }));

    act(() => { created[0].fire("sessions", { s: 1 }); });
    expect(onSessions).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();

    act(() => { created[0].fire("event", { e: 1 }); });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes individual handlers without closing the socket while others remain", async () => {
    const { useSSE } = await import("./useSSE");
    const a = vi.fn();
    const b = vi.fn();
    const { unmount: unmountA } = renderHook(() => useSSE({ sessions: a }));
    renderHook(() => useSSE({ sessions: b }));

    unmountA();
    act(() => { created[0].fire("sessions", { s: 1 }); });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(created[0].close).not.toHaveBeenCalled();
  });

  it("closes the socket when the last subscriber unmounts", async () => {
    const { useSSE } = await import("./useSSE");
    const { unmount } = renderHook(() => useSSE({ sessions: () => {} }));
    unmount();
    expect(created[0].close).toHaveBeenCalled();
  });

  it("ignores malformed (non-JSON) frames instead of throwing", async () => {
    const { useSSE } = await import("./useSSE");
    const fn = vi.fn();
    renderHook(() => useSSE({ sessions: fn }));
    act(() => { created[0].onmessage?.({ data: "{not json" }); });
    expect(fn).not.toHaveBeenCalled();
  });
});
