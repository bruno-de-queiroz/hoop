# Bug: mobile on-screen keyboard covers the composer

## Summary
On mobile (reported on iOS), opening the on-screen keyboard covers the message
composer / latest messages — you can't see the input you're typing into.

## Root cause
`AppShell` (`plugins/hoop/dashboard/app/components/ui/AppShell.tsx`) sized the
whole app with `h-[100dvh]`. The `dvh` unit tracks the *dynamic* viewport
(browser address bar) but **not** the software keyboard: when the keyboard opens
on iOS/Android the layout viewport keeps its full height and only
`window.visualViewport` shrinks. So the `100dvh` shell stayed full-height and its
bottom-anchored composer (a `shrink-0` footer in the flex column) ended up behind
the keyboard.

## Fix (implemented)
Drive the shell's height from the live `visualViewport.height` instead of a fixed
`100dvh`:

- New hook `plugins/hoop/dashboard/app/components/ui/useVisualViewportHeight.ts`
  mirrors `window.visualViewport.height` into the `--app-height` CSS variable and
  updates it on the viewport `resize`/`scroll` events (keyboard show/hide). It
  also locks `body` scrolling while the shell is mounted so iOS can't scroll the
  taller-than-visual layout viewport and tuck the composer back under the
  keyboard. Body-scroll lock is scoped to the shell (set/restored in the hook),
  so other routes (`/join`, `/left`, `/ui-gallery`) are unaffected.
- `AppShell` calls the hook and uses `h-[var(--app-height,100dvh)]`. The `100dvh`
  fallback keeps the current behavior before JS runs / on browsers without
  `visualViewport`, so nothing regresses there. The existing flex layout
  (transcript `flex-1`, composer `shrink-0`) makes the transcript absorb the
  shrink while the composer stays visible just above the keyboard.

The composer already respects the home-indicator area via
`pb-[max(0.75rem,env(safe-area-inset-bottom))]` (`ShellComposer.tsx`); this fix
handles the keyboard, which safe-area insets don't cover.

## Tests (added)
`useVisualViewportHeight.test.tsx`:
- sets `--app-height` from `visualViewport.height` and follows a keyboard-open
  resize (800 → 520);
- locks body scroll while mounted and restores it (plus removes listeners and the
  CSS var) on unmount;
- falls back to `window.innerHeight` when `visualViewport` is unavailable.

Verified: full dashboard suite green (`npx vitest run` → 53 files / 449 tests) and
`npx tsc --noEmit` clean.

## Verification (manual, recommended)
Load the dashboard on a real iOS Safari / Android Chrome device (or the tunnel
URL), focus the composer, and confirm the input and latest messages stay visible
above the keyboard as it opens and closes. Emulator devtools don't reproduce the
`visualViewport` keyboard behavior faithfully — test on a device.
