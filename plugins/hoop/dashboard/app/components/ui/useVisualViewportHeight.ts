"use client";
import { useEffect } from "react";

/**
 * Pin the app to the *visual* viewport height so the composer isn't hidden
 * behind the on-screen keyboard on mobile.
 *
 * `100dvh` tracks browser chrome (the address bar) but NOT the software
 * keyboard: when the keyboard opens on iOS/Android the layout viewport stays
 * full-height and only `window.visualViewport` shrinks. A `100dvh` app shell
 * therefore keeps its full height and the bottom-anchored composer ends up
 * behind the keyboard.
 *
 * We mirror `visualViewport.height` into the `--app-height` CSS variable (read
 * by AppShell as `height: var(--app-height, 100dvh)`) and update it as the
 * keyboard shows/hides, so the flex column shrinks and the composer stays just
 * above the keyboard. We also lock body scrolling while the shell is mounted so
 * iOS can't scroll the (now taller-than-visual) layout viewport and tuck the
 * composer back under the keyboard.
 *
 * Falls back to the CSS `100dvh` value when `visualViewport` is unavailable
 * (older browsers, SSR first paint), so nothing regresses there.
 */
export function useVisualViewportHeight() {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";

    const vv = window.visualViewport;
    const apply = () => {
      const h = vv ? vv.height : window.innerHeight;
      root.style.setProperty("--app-height", `${Math.round(h)}px`);
    };
    apply();

    // `resize` fires when the keyboard shows/hides (visualViewport shrinks or
    // grows); `scroll` catches iOS shifting the visual viewport without a
    // resize. The window `resize` fallback covers browsers without
    // visualViewport, keeping --app-height in sync with innerHeight there.
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);

    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      root.style.removeProperty("--app-height");
      body.style.overflow = prevOverflow;
      body.style.overscrollBehavior = prevOverscroll;
    };
  }, []);
}
