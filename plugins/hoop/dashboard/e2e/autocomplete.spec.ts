import { test, expect } from "@playwright/test";
import { waitForSandboxReady, wipeSessions } from "./helpers";

/**
 * Slash + @file autocomplete exercised against the live commands +
 * files endpoints. Plugin-agnostic: we read whichever item is
 * currently highlighted and assert that THAT value is what gets
 * inserted on Enter.
 *
 * Active-row anchor is `data-testid="autocomplete-item-active"`
 * (set on the highlighted `<button>`); no coupling to internal
 * Tailwind classes.
 */
test.describe("autocomplete", () => {
  test.beforeEach(async ({ request, page }) => {
    await waitForSandboxReady(request);
    await wipeSessions(page);
  });

  test("slash + @file autocomplete inserts the right tokens", async ({ page }) => {
    await page.goto("/");

    // Create a session anchored at /workspace via the empty-state large form.
    await page.getByRole("button", { name: /create session/i }).click();
    const composer = page.getByPlaceholder(/type a message/i);
    await expect(composer).toBeEnabled({ timeout: 10_000 });

    const popover = page.getByTestId("autocomplete-popover");

    // --- slash autocomplete: any command works ---
    await composer.fill("/");
    await expect(popover).toBeVisible({ timeout: 3_000 });

    const activeItem = popover.getByTestId("autocomplete-item-active");
    await expect(activeItem).toBeVisible();
    const firstInsert = ((await activeItem.locator("span.truncate").first().textContent()) ?? "").trim();
    expect(firstInsert).toMatch(/^\/[a-z-]+/i);

    await composer.press("Enter");
    const afterSlashInsert = (await composer.inputValue()) ?? "";
    expect(afterSlashInsert).toBe(`${firstInsert} `);

    // --- @ file autocomplete ---
    await composer.fill(afterSlashInsert + "@");
    // Poll instead of waitForTimeout: the useFiles hook debounces 120ms
    // and then fires the fetch; we wait for the active item to be
    // populated. The popover renders the full insert token, so a file/dir
    // entry reads as "@<name>" (mirroring the "/<cmd>" slash entries above).
    await expect
      .poll(
        async () => {
          const txt = (await popover
            .getByTestId("autocomplete-item-active")
            .locator("span.truncate")
            .first()
            .textContent()) ?? "";
          return txt.trim();
        },
        { timeout: 5_000, message: "file popover didn't surface any item" },
      )
      .toMatch(/^@[\w./-]+$/);

    const fileInsert = (
      (await popover
        .getByTestId("autocomplete-item-active")
        .locator("span.truncate")
        .first()
        .textContent()) ?? ""
    ).trim();

    await composer.press("Enter");
    const finalValue = (await composer.inputValue()) ?? "";
    expect(finalValue.endsWith(`${fileInsert} `)).toBe(true);
    // Slash insertion survives — the original slash prefix is still there.
    expect(finalValue.startsWith(firstInsert + " ")).toBe(true);
  });
});
