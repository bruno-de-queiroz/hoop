import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useVisualViewportHeight } from "./useVisualViewportHeight";

// A minimal fake of window.visualViewport we can drive in tests: mutate
// `height` then dispatch the event the hook listens for.
function makeFakeViewport(height: number) {
  const listeners: Record<string, Set<() => void>> = { resize: new Set(), scroll: new Set() };
  return {
    height,
    addEventListener: (type: string, fn: () => void) => listeners[type]?.add(fn),
    removeEventListener: (type: string, fn: () => void) => listeners[type]?.delete(fn),
    emit: (type: "resize" | "scroll") => listeners[type].forEach((fn) => fn()),
    listenerCount: (type: "resize" | "scroll") => listeners[type].size,
  };
}

describe("useVisualViewportHeight", () => {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");

  afterEach(() => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    document.documentElement.style.removeProperty("--app-height");
    document.body.style.overflow = "";
    document.body.style.overscrollBehavior = "";
  });

  it("sets --app-height from visualViewport.height and updates on keyboard resize", () => {
    const vp = makeFakeViewport(800);
    Object.defineProperty(window, "visualViewport", { value: vp, configurable: true });

    renderHook(() => useVisualViewportHeight());
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("800px");

    // Keyboard opens → visualViewport shrinks → variable follows.
    vp.height = 520;
    vp.emit("resize");
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("520px");
  });

  it("locks body scroll while mounted and restores it on unmount", () => {
    const vp = makeFakeViewport(800);
    Object.defineProperty(window, "visualViewport", { value: vp, configurable: true });

    const { unmount } = renderHook(() => useVisualViewportHeight());
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("none");

    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
    expect(vp.listenerCount("resize")).toBe(0);
    expect(vp.listenerCount("scroll")).toBe(0);
  });

  it("falls back to window.innerHeight when visualViewport is unavailable", () => {
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 640, configurable: true });

    renderHook(() => useVisualViewportHeight());
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("640px");
  });
});
