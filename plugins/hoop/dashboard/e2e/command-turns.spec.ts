import { test, expect } from "@playwright/test";
import { waitForSandboxReady, wipeSessions } from "./helpers";

/**
 * Smoke coverage for slash-command turns rendered in the transcript.
 *
 * Regressions pinned here (all three were broken/absent before):
 *   - `/plan <task>` shows EXACTLY ONE command card — no duplicate bubble
 *     (the sandbox strips `/plan` before the model, so the optimistic row and
 *     the real UserPromptSubmit used to disagree and render twice).
 *   - `/model <alias>` is intercepted client-side: it switches the session and
 *     echoes once as a command card + a "Model set to …" confirmation, and is
 *     NOT forwarded to the model as plain text.
 *   - `/stop` is intercepted client-side: it aborts the in-flight turn and
 *     echoes once as a command card + a "Turn stopped." confirmation.
 *
 * A command card carries data-testid="command-turn"; an ordinary user prompt
 * carries data-testid="user-prompt". The core assertion is always "the command
 * shows once, and never as an ordinary prompt bubble".
 */
test.describe("slash-command turns", () => {
  test.beforeEach(async ({ request, page }) => {
    await waitForSandboxReady(request);
    await wipeSessions(page);
  });

  async function createSession(page: import("@playwright/test").Page) {
    await page.goto("/");
    const cwdInput = page.getByPlaceholder("/home/agent/workspace").first();
    await expect(cwdInput).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /create session/i }).click();
    const composer = page.getByPlaceholder(/type a message/i);
    await expect(composer).toBeEnabled({ timeout: 10_000 });
    return composer;
  }

  test("/plan renders exactly one command card, never a duplicate bubble", async ({ page }) => {
    const composer = await createSession(page);
    const transcript = page.getByTestId("shell-transcript");

    await composer.fill("/plan reply with the single word OK");
    await page.getByRole("button", { name: /^send$/i }).click();

    // The command card is the reconciled representation of the turn.
    const card = transcript.getByTestId("command-turn");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toHaveCount(1);
    await expect(card.getByText("plan reply with the single word OK")).toBeVisible();

    // The optimistic bubble must have been REPLACED, not left alongside — no
    // ordinary prompt bubble survives for this turn.
    await expect(transcript.getByTestId("user-prompt")).toHaveCount(0);
    // And the raw structured wrapper never leaks into the rendered text.
    const txt = (await transcript.textContent()) ?? "";
    expect(txt).not.toMatch(/\[UserPromptSubmit\]\s*\|\s*prompt=/);
  });

  test("/model switches the session and echoes once (never sent to the model)", async ({ page }) => {
    const composer = await createSession(page);
    const transcript = page.getByTestId("shell-transcript");

    await composer.fill("/model haiku");
    await page.getByRole("button", { name: /^send$/i }).click();

    const card = transcript.getByTestId("command-turn");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toHaveCount(1);
    await expect(card.getByText("model haiku")).toBeVisible();

    // The switch confirmation is the result — this is the proof the command was
    // handled as a control action, not echoed to the model as a prompt.
    await expect(transcript.getByText(/Model set to haiku/i)).toBeVisible({ timeout: 10_000 });
    await expect(transcript.getByTestId("user-prompt")).toHaveCount(0);
  });

  test("/stop aborts the in-flight turn and echoes once", async ({ page }) => {
    const composer = await createSession(page);
    const transcript = page.getByTestId("shell-transcript");

    // Kick off a turn that keeps the model busy long enough to interrupt.
    await composer.fill("count slowly from 1 to 100, one number per line");
    await page.getByRole("button", { name: /^send$/i }).click();

    // Wait until the model is actually working, then stop it.
    await expect(page.getByTestId("waiting-indicator")).toBeVisible({ timeout: 15_000 });
    await composer.fill("/stop");
    await page.getByRole("button", { name: /^send$/i }).click();

    // The /stop command echoes once as a command card…
    const stopCard = transcript.getByTestId("command-turn").filter({ hasText: "stop" });
    await expect(stopCard).toBeVisible({ timeout: 15_000 });
    await expect(stopCard).toHaveCount(1);
    // …and the turn is confirmed stopped, clearing the waiting indicator.
    await expect(transcript.getByText(/Turn stopped/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("waiting-indicator")).toBeHidden({ timeout: 15_000 });
  });
});
