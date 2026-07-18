import { test, expect } from "@playwright/test";
import { waitForSandboxReady, wipeSessions } from "./helpers";

/**
 * Rename flow + delete flow exercised against the live stack.
 *
 * Pins:
 *   - Click the header name (a `title="Rename"` button) → input (aria-labelled
 *     "Rename session") → type new value → Enter saves via PATCH and the
 *     sidebar updates.
 *   - Click ⋯ (title="More") → "Delete session" → confirm dialog → DELETE
 *     fires; the
 *     URL clears (?session is dropped) and the sidebar drops the row.
 */
test.describe("rename + delete", () => {
  test.beforeEach(async ({ request, page }) => {
    await waitForSandboxReady(request);
    await wipeSessions(page);
  });

  test("rename via header, then delete via header menu", async ({ page }) => {
    await page.goto("/");

    // Create a session via the empty-state large form.
    await page.getByRole("button", { name: /create session/i }).click();

    const headerName = page.locator('button[title="Rename"]');
    await expect(headerName).toBeVisible({ timeout: 10_000 });

    // Capture the original haiku name so the assertions can prove the
    // value really changed (rather than "any non-empty string").
    const original = ((await headerName.textContent()) ?? "").trim();
    expect(original).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);

    // Click to enter rename mode.
    await headerName.click();

    const input = page.getByLabel("Rename session", { exact: true });
    await expect(input).toBeVisible();
    await input.fill("my-custom-label");
    await input.press("Enter");

    // Header shows the new name.
    await expect(headerName).toHaveText("my-custom-label", { timeout: 5_000 });

    // Sidebar reflects the same value.
    await expect(page.getByText("my-custom-label").first()).toBeVisible();

    // Now delete via the ⋯ header menu. confirm() is auto-accepted.
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: /delete session/i }).click();

    // The frame returns to the empty state — the new-session form heading
    // is present, and the textarea isn't.
    await expect(page.getByText(/start a session/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder(/type a message/i)).toHaveCount(0);

    // URL no longer carries ?session=.
    await expect(page).toHaveURL((u) => !u.searchParams.has("session"));

    // Sidebar no longer shows the renamed row.
    await expect(page.getByText("my-custom-label")).toHaveCount(0);
  });
});
