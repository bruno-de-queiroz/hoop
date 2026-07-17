/**
 * Cwd allowlist for dashboard-spawned sessions. The primary defense is
 * filesystem permissions via the container's non-root user (Dockerfile drops
 * to `node`). This is the secondary layer: reject obviously dangerous paths
 * before they ever reach `spawn`, and let an operator restrict further via
 * an env var.
 *
 * HOOP_CWD_ROOTS: comma-separated list of allowed root paths. When set,
 * the cwd must equal one of them or be a subpath of one. When unset, the
 * built-in deny rules below are the only enforcement.
 *
 * Symlink safety: both the input path and each allowed root are resolved via
 * realpathSync.native before comparison so a symlink inside an allowed root
 * cannot point outside it to bypass the policy.
 */

import { realpathSync } from "node:fs";
import { log } from "@shared/logger";

const ALWAYS_DENIED_PREFIXES = ["/etc", "/proc", "/dev", "/sys", "/boot", "/var/run", "/var/lib/secrets"];

/**
 * Resolve a path to its OS-level canonical form. Returns null on any failure
 * (path does not exist, IO error, etc.).
 */
export function canonicalize(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Resolve always-denied prefixes once at module load. On macOS /etc resolves
 * to /private/etc, so we must compare against the resolved forms.
 * Prefixes that don't exist on this host are kept in their raw form so that
 * syntactic checks (e.g. /proc on macOS) still work.
 */
const RESOLVED_DENIED_PREFIXES: string[] = ALWAYS_DENIED_PREFIXES.map(
  (p) => canonicalize(p) ?? p,
);

/**
 * Return true when the canonical path (or its parents) matches any denied prefix.
 */
function isUnderDeniedPrefix(resolvedPath: string): { denied: true; prefix: string } | false {
  for (const prefix of RESOLVED_DENIED_PREFIXES) {
    if (resolvedPath === prefix || resolvedPath.startsWith(prefix + "/")) {
      return { denied: true, prefix };
    }
  }
  // Also check the raw prefixes in case a path resolves to something that
  // contains one of the raw prefix strings (belt-and-suspenders).
  for (const prefix of ALWAYS_DENIED_PREFIXES) {
    if (resolvedPath === prefix || resolvedPath.startsWith(prefix + "/")) {
      return { denied: true, prefix };
    }
  }
  return false;
}

/**
 * Full cwd policy check with canonical path resolution.
 *
 * Returns `{ ok: true, canonical }` when the path is allowed, or
 * `{ ok: false, reason }` when it is rejected.
 *
 * Steps:
 *  1. Syntactic sanity checks (null byte, non-string, etc.).
 *  2. Resolve the path via realpathSync.native — rejects non-existent paths
 *     and surfaces symlink targets.
 *  3. Check canonical path against always-denied prefixes.
 *  4. If HOOP_CWD_ROOTS is set, verify the canonical path sits under at
 *     least one (also canonicalized) allowed root.
 */
export function isCwdAllowed(
  rawPath: string,
): { ok: true; canonical: string } | { ok: false; reason: string } {
  if (typeof rawPath !== "string" || !rawPath) {
    return { ok: false, reason: "cwd must be a non-empty string" };
  }
  if (rawPath.includes("\0")) {
    return { ok: false, reason: "cwd contains a null byte" };
  }

  // Resolve to canonical path (follows symlinks, resolves . and ..).
  // Rejects non-existent paths (fail closed).
  const resolved = canonicalize(rawPath);
  if (resolved === null) {
    return { ok: false, reason: `cwd does not exist or cannot be resolved: ${rawPath}` };
  }

  const denied = isUnderDeniedPrefix(resolved);
  if (denied) {
    return { ok: false, reason: `cwd under ${denied.prefix} is not allowed` };
  }

  const envRoots = process.env.HOOP_CWD_ROOTS;
  if (envRoots) {
    const rawRoots = envRoots
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter((s) => s.length > 0);

    // Canonicalize each allowed root; skip roots that don't exist (with warning).
    const resolvedRoots: string[] = [];
    for (const root of rawRoots) {
      const resolvedRoot = canonicalize(root);
      if (resolvedRoot === null) {
        log.warn("cwd-policy", "configured root does not exist or cannot be resolved; skipping", { root });
        continue;
      }
      resolvedRoots.push(resolvedRoot);
    }

    const matched = resolvedRoots.some(
      (r) => resolved === r || resolved.startsWith(r + "/"),
    );
    if (!matched) {
      return {
        ok: false,
        reason: `cwd is not under any allowed root (${rawRoots.join(", ")})`,
      };
    }
  }

  return { ok: true, canonical: resolved };
}

/**
 * Legacy export: backwards-compatible boolean wrapper around cwd policy check.
 * Existing callers that only need ok/not-ok can keep using this without
 * changes. Also used by server.ts at POST /sessions time.
 *
 * This variant performs full canonicalization when the path exists. When the
 * path does NOT exist AND no env allowlist is configured, the always-denied
 * prefix check is still applied syntactically so that e.g. /etc/foo is
 * rejected even on hosts where that path somehow doesn't exist.
 *
 * When an env allowlist IS configured, a non-existent path is always rejected
 * (fail closed) because we cannot safely canonicalize it for comparison.
 */
export function isAllowedCwd(rawPath: string): { ok: boolean; reason?: string } {
  if (typeof rawPath !== "string" || !rawPath) {
    return { ok: false, reason: "cwd must be a non-empty string" };
  }
  if (rawPath.includes("\0")) {
    return { ok: false, reason: "cwd contains a null byte" };
  }
  // Reject `..` segments before normalisation — they don't belong in a value
  // a user typed into a form field.
  if (rawPath.split("/").some((seg) => seg === "..")) {
    return { ok: false, reason: "cwd contains '..' path traversal" };
  }

  // Try canonical resolution. When it succeeds we use it for all checks.
  const resolved = canonicalize(rawPath);

  if (resolved !== null) {
    // Full canonicalized check.
    const denied = isUnderDeniedPrefix(resolved);
    if (denied) {
      return { ok: false, reason: `cwd under ${denied.prefix} is not allowed` };
    }

    const envRoots = process.env.HOOP_CWD_ROOTS;
    if (envRoots) {
      const rawRoots = envRoots
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter((s) => s.length > 0);

      // Canonicalize each allowed root; skip roots that don't exist (with warning).
      const resolvedRoots: string[] = [];
      for (const root of rawRoots) {
        const resolvedRoot = canonicalize(root);
        if (resolvedRoot === null) {
          log.warn("cwd-policy", "configured root does not exist or cannot be resolved; skipping", { root });
          continue;
        }
        resolvedRoots.push(resolvedRoot);
      }

      const matched = resolvedRoots.some(
        (r) => resolved === r || resolved.startsWith(r + "/"),
      );
      if (!matched) {
        return { ok: false, reason: `cwd is not under any allowed root (${rawRoots.join(", ")})` };
      }
    }

    return { ok: true };
  }

  // Path does not exist (resolved === null).
  // With an env allowlist active: fail closed — we cannot canonicalize for
  // comparison, so we cannot safely allow this path.
  const envRoots = process.env.HOOP_CWD_ROOTS;
  if (envRoots) {
    return { ok: false, reason: `cwd does not exist or cannot be resolved: ${rawPath}` };
  }

  // No env restriction: fall back to syntactic always-denied check only.
  // This preserves backwards-compatible behaviour for tests and deployments
  // that check hypothetical paths without creating them first.
  for (const prefix of ALWAYS_DENIED_PREFIXES) {
    if (rawPath === prefix || rawPath.startsWith(prefix + "/")) {
      return { ok: false, reason: `cwd under ${prefix} is not allowed` };
    }
  }

  return { ok: true };
}
