import { type APIRequestContext, type Page } from "@playwright/test";

/**
 * Shared helpers for the dashboard e2e suite. Centralises:
 *   - cookie/token bootstrap (the dashboard sets an HttpOnly cookie on
 *     first page-load + injects the same value in a <meta> tag for the
 *     monkey-patched fetch). The Playwright request context inherits the
 *     cookie but needs to read the token from the meta tag for mutating
 *     requests.
 *   - session cleanup so each test starts from an empty sidebar.
 *   - waitForSandboxReady so flaky cold-starts don't fail the suite.
 */

export async function readDashboardToken(page: Page): Promise<string> {
  // The meta tag is server-rendered into <head>; reading it via Playwright
  // is more reliable than parsing it out of an HTTP response body.
  await page.goto("/");
  const token = await page.locator("meta[name='x-dashboard-token']").getAttribute("content");
  if (!token) throw new Error("dashboard token meta tag is empty — is HOOP_DASHBOARD_TOKEN set?");
  return token;
}

/**
 * Delete every existing session via the dashboard API. Used in beforeEach
 * to isolate specs; the alternative (one shared session set) makes
 * assertions order-dependent. Runs the requests INSIDE the browser context
 * (`page.evaluate`) so cookies the middleware set on first navigation are
 * present — Playwright's top-level `request` context doesn't share cookies
 * with `page`.
 */
export async function wipeSessions(page: Page): Promise<void> {
  await readDashboardToken(page); // ensure /goto fired so the cookie is set
  await page.evaluate(async () => {
    const meta = document.querySelector("meta[name='x-dashboard-token']");
    const token = meta?.getAttribute("content");
    if (!token) throw new Error("no dashboard token meta");
    const r = await fetch("/api/sessions");
    if (!r.ok) throw new Error(`/api/sessions GET → ${r.status}`);
    const sessions: Array<{ sessionId?: string }> = await r.json();
    for (const s of sessions) {
      if (!s.sessionId) continue;
      await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}`, {
        method: "DELETE",
        headers: { "x-dashboard-token": token },
      });
    }
  });
  // Wait for /api/sessions to actually report empty — the DELETE calls
  // return ok before the sandbox finishes terminating subprocesses, and
  // the sidebar SSE refresh can lag. Poll for up to 10s.
  await page.waitForFunction(
    async () => {
      const r = await fetch("/api/sessions");
      if (!r.ok) return false;
      const list = (await r.json()) as Array<{ lifecycle?: string }>;
      // Treat expired-or-dormant residue as "gone" — the sidebar
      // filters those out anyway, and the empty-state large form
      // mounts whenever no `?session=` is set.
      return list.every((s) => s.lifecycle === "expired");
    },
    null,
    { timeout: 10_000 },
  );
}

/**
 * Block until the dashboard's `/api/health` returns OK. Useful when the
 * launcher just restarted the stack and Playwright's first navigation
 * races compose's depends_on. Caps at ~10 seconds.
 */
export async function waitForSandboxReady(request: APIRequestContext): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await request.get("/api/health");
      if (r.ok()) return;
    } catch { /* keep trying */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dashboard /api/health didn't come up within 10s");
}
