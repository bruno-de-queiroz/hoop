import { test, expect } from "@playwright/test";
import { waitForSandboxReady, wipeSessions } from "./helpers";

/**
 * Two-turn continuity: send message 1, wait for the response, send
 * message 2, verify BOTH prompts are still in the transcript AS
 * EXACTLY ONE ROW EACH. The count assertion pins the optimistic
 * reconciliation contract — a regression that left both the
 * optimistic and the real UserPromptSubmit in place would render two
 * "ALPHA" rows, and the test would catch it.
 *
 * Asserts scoped to the transcript container (data-testid="transcript")
 * so matching text in the sidebar / events panel can't cause a false
 * positive.
 *
 * (The plan's dormant-revive spec required a sandbox restart to force
 * dormant — heavy and brittle for an inner-loop suite. This test
 * covers the practical regression without the restart cost. Deeper
 * dormant-revive behaviour is covered by Phase 3 provider unit tests.)
 */
test.describe("two-turn continuity", () => {
  test.beforeEach(async ({ request, page }) => {
    await waitForSandboxReady(request);
    await wipeSessions(page);
  });

  test("two consecutive turns each appear exactly once in the transcript", async ({ page }) => {
    await page.goto("/");

    // Create + first turn.
    await page.getByRole("button", { name: /^create$/i }).click();
    const composer = page.getByPlaceholder(/type a message/i);
    await expect(composer).toBeEnabled({ timeout: 10_000 });

    const transcript = page.getByTestId("transcript");
    const waiting = page.getByTestId("waiting-indicator");

    await composer.fill("reply with the single word ALPHA");
    await page.getByRole("button", { name: /^send$/i }).click();

    // Waiting shows then clears (proves a turn cycle ran).
    await expect(waiting).toBeVisible({ timeout: 5_000 });
    await expect(waiting).toBeHidden({ timeout: 60_000 });

    // EXACTLY ONE user-prompt row for the first prompt: optimistic
    // reconciled. Scoped to `data-testid="user-prompt"` so the
    // assistant's response containing the same words can't false-positive.
    const userPrompts = transcript.getByTestId("user-prompt");
    await expect(userPrompts.filter({ hasText: "reply with the single word ALPHA" })).toHaveCount(1);

    // Second turn.
    await composer.fill("reply with the single word BETA");
    await page.getByRole("button", { name: /^send$/i }).click();
    await expect(waiting).toBeVisible({ timeout: 5_000 });
    await expect(waiting).toBeHidden({ timeout: 60_000 });

    // BOTH prompts must still be visible, each as exactly one user-prompt row.
    await expect(userPrompts.filter({ hasText: "reply with the single word ALPHA" })).toHaveCount(1);
    await expect(userPrompts.filter({ hasText: "reply with the single word BETA" })).toHaveCount(1);
  });
});
