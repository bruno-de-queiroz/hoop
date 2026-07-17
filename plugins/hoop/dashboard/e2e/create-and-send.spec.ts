import { test, expect } from "@playwright/test";
import { waitForSandboxReady, wipeSessions } from "./helpers";

/**
 * Happy-path: create a session via the empty-state form, send a
 * message, watch the optimistic echo + waiting indicator + real Stop
 * arrival flow.
 *
 * Pins:
 *   - The empty-state large form creates a session on Create click.
 *   - Server-seeded haiku name lands in both the header AND the
 *     sidebar (displayName plumbing is correct end-to-end).
 *   - Composer accepts input on the freshly-created session.
 *   - Optimistic UserPromptSubmit lands in the transcript immediately.
 *   - Waiting indicator surfaces and clears on the first non-prompt event.
 *   - Stats strip populates with non-zero in AND out token counts
 *     (the sandbox's turn → sessions SSE bridge is wired correctly).
 */
test.describe("create + send", () => {
  test.beforeEach(async ({ request, page }) => {
    await waitForSandboxReady(request);
    await wipeSessions(page);
  });

  test("create a session, send a message, end-to-end through Stop + stats", async ({ page }) => {
    await page.goto("/");

    // Empty-state large form is the canonical "no session selected"
    // surface; its mere presence implies both panel empty states.
    const cwdInput = page.getByPlaceholder("/home/agent/workspace").first();
    await expect(cwdInput).toBeVisible({ timeout: 10_000 });
    await expect(cwdInput).toHaveValue("/home/agent/workspace");
    await page.getByRole("button", { name: /^create$/i }).click();

    // Header should populate with a haiku-shaped displayName.
    const headerName = page.getByRole("button", { name: "Rename session" });
    await expect(headerName).toBeVisible({ timeout: 10_000 });
    const name = (await headerName.textContent())?.trim() ?? "";
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);

    // Sidebar shows the same name (Playwright auto-escapes the
    // interpolated string inside getByText).
    await expect(page.getByText(name).first()).toBeVisible();

    // Composer is reachable and enabled.
    const composer = page.getByPlaceholder(/type a message/i);
    await expect(composer).toBeEnabled({ timeout: 10_000 });

    // Send a cheap prompt that doesn't require tool calls.
    await composer.fill("reply with the single word OK");
    await page.getByRole("button", { name: /^send$/i }).click();

    // Optimistic echo lands inside the transcript (not "anywhere on
    // the page" — important: the sidebar or events panel could surface
    // matching strings and create false positives).
    const transcript = page.getByTestId("transcript");
    await expect(
      transcript.getByText(/reply with the single word OK/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    // Waiting indicator surfaces.
    const waiting = page.getByTestId("waiting-indicator");
    await expect(waiting).toBeVisible({ timeout: 5_000 });

    // Waiting clears once the assistant replies (claude --print can take
    // 5–15s for a no-tool reply, so we're generous).
    await expect(waiting).toBeHidden({ timeout: 60_000 });

    // Stats strip populates: BOTH input and output token counts are
    // non-zero. The `not.toContain("0 in / 0 out")` shortcut would
    // false-positive when the rendered value is e.g. "100 in / 0 out"
    // (substring overlap on the first "0"); a regex with explicit
    // groups gates that.
    const statsLine = page.getByText(/tokens:/);
    await expect(statsLine).toBeVisible({ timeout: 10_000 });
    await expect(async () => {
      const t = (await statsLine.textContent()) ?? "";
      // Match "tokens: <in> in / <out> out" with k/m suffix support.
      const m = t.match(/tokens:\s*(\d+(?:\.\d+)?)([km])?\s+in\s*\/\s*(\d+(?:\.\d+)?)([km])?\s+out/);
      expect(m, `stats line didn't match expected shape: "${t}"`).not.toBeNull();
      const inCount = parseFloat(m![1]) * suffix(m![2]);
      const outCount = parseFloat(m![3]) * suffix(m![4]);
      expect(inCount, `input tokens stuck at ${inCount} in "${t}"`).toBeGreaterThan(0);
      expect(outCount, `output tokens stuck at ${outCount} in "${t}"`).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000 });

    // Assistant message rendering: the transcript must NOT contain the
    // sandbox's structured-log wrapper. A regression that fed
    // `row.text` directly to Markdown would surface
    // `[Stop] | last_assistant_message=...` to the user.
    const transcriptText = (await transcript.textContent()) ?? "";
    expect(
      transcriptText,
      "transcript leaked the sandbox's log-line wrapper",
    ).not.toMatch(/\[Stop\]\s*\|\s*last_assistant_message=/);
    expect(transcriptText).not.toMatch(/\[UserPromptSubmit\]\s*\|\s*prompt=/);
  });
});

function suffix(s: string | undefined): number {
  if (s === "k") return 1_000;
  if (s === "m") return 1_000_000;
  return 1;
}
