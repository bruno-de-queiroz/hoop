import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, chownSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./lib/paths";
import { log } from "@shared/logger";

const TOKEN_LEN_BYTES = 32;

export const SANDBOX_TOKEN_HEADER = "x-sandbox-token";
export const HOOK_TOKEN_HEADER = "x-hook-token";

const SANDBOX_TOKEN_FILE = process.env.HOOP_SANDBOX_TOKEN_FILE
  || "/var/run/hoop/sandbox.token";
const HOOK_TOKEN_FILE = join(STATE_DIR, "hook.token");

let cachedSandbox: string | null = null;
let cachedHook: string | null = null;

/**
 * Per-install random token for dashboard <-> sandbox auth. Generated on first
 * sandbox start, persisted at a known path the dashboard can read, reused on
 * subsequent boots. The dashboard re-reads the file lazily (on 401 retry) so
 * rotation across a sandbox restart is transparent.
 */
export function sandboxToken(): string {
  if (cachedSandbox) return cachedSandbox;
  try {
    if (existsSync(SANDBOX_TOKEN_FILE)) {
      const t = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim();
      if (t.length >= TOKEN_LEN_BYTES * 2) {
        cachedSandbox = t;
        return t;
      }
    }
  } catch { /* ignore */ }

  const fresh = randomBytes(TOKEN_LEN_BYTES).toString("hex");
  try {
    mkdirSync(dirname(SANDBOX_TOKEN_FILE), { recursive: true });
    // 0640 + group=hoop (gid 1100). The dashboard image's `node` user
    // is added to that group; the sandbox runs as `agent` (also in 1100).
    // No "world" bit means a third container that mounts the volume by
    // mistake can't read the token unless it joins the group on purpose.
    writeFileSync(SANDBOX_TOKEN_FILE, fresh, { mode: 0o640 });
    chmodSync(SANDBOX_TOKEN_FILE, 0o640);
    try { chownSync(SANDBOX_TOKEN_FILE, -1, 1100); } catch { /* group may not exist outside Docker */ }
  } catch (err) {
    log.error("sandbox-auth", "failed to persist sandbox token", { err: String(err) });
  }
  cachedSandbox = fresh;
  return fresh;
}

/**
 * Hook emitter token. Hook scripts run inside the sandbox container, read this
 * from disk, and POST it as X-Hook-Token to /ingest. Separate from the sandbox
 * token: a leaked hook secret only grants append-event-row, never spawn-agent.
 */
export function hookToken(): string {
  if (cachedHook) return cachedHook;
  try {
    if (existsSync(HOOK_TOKEN_FILE)) {
      const t = readFileSync(HOOK_TOKEN_FILE, "utf-8").trim();
      if (t.length >= TOKEN_LEN_BYTES * 2) {
        cachedHook = t;
        return t;
      }
    }
  } catch { /* ignore */ }

  const fresh = randomBytes(TOKEN_LEN_BYTES).toString("hex");
  try {
    mkdirSync(dirname(HOOK_TOKEN_FILE), { recursive: true });
    // 0644: the hook script (running inside the same container as the
    // sandbox process, spawned by claude as a child of the user-turn
    // process) needs to read this token. On macOS Docker Desktop the
    // bind-mount makes every file appear under the host user's uid
    // regardless of what we chmod from inside — owner-only modes break the
    // intra-container read path. The hook.token lives entirely inside the
    // sandbox profile and never leaves the container; the trust boundary
    // is the container, not the file mode.
    writeFileSync(HOOK_TOKEN_FILE, fresh, { mode: 0o644 });
    chmodSync(HOOK_TOKEN_FILE, 0o644);
  } catch (err) {
    log.error("sandbox-auth", "failed to persist hook token", { err: String(err) });
  }
  cachedHook = fresh;
  return fresh;
}

function constantTimeEquals(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "utf-8"), Buffer.from(expected, "utf-8"));
  } catch {
    return false;
  }
}

export function sandboxTokenMatches(provided: string | null | undefined): boolean {
  if (!provided) return false;
  return constantTimeEquals(provided, sandboxToken());
}

export function hookTokenMatches(provided: string | null | undefined): boolean {
  if (!provided) return false;
  return constantTimeEquals(provided, hookToken());
}
