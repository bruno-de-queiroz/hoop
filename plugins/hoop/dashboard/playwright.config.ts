import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the dashboard e2e suite. Targets the running stack
 * at http://localhost:7842 (started by bin/hoop-dashboard). Vitest is
 * the inner-loop suite; Playwright runs against the real browser + real
 * Next.js runtime + real sandbox so behaviors that depend on App Router
 * hooks, cookies, and SSE get exercised end-to-end.
 *
 * Run: `npx playwright test` from the dashboard directory.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,           // sessions are shared state; serialise to avoid races
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  use: {
    baseURL: process.env.HOOP_BASE_URL ?? "http://localhost:7842",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Each test starts from a clean session list via beforeEach hooks.
    // Keeping browsing context separate per test (default) avoids cookie
    // bleed between specs.
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
