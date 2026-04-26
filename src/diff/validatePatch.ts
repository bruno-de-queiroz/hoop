import { resolve, sep } from "node:path";

const DIFF_HEADER_PATTERN = /^---\s/m;
const DIFF_HEADER_PLUS_PATTERN = /^\+\+\+\s/m;
const HUNK_HEADER_PATTERN = /^@@\s/m;

const PATCH_HEADER_PATTERN = /^(?:---\s+a\/(.+?)$|^\+\+\+\s+b\/(.+?)$)/gm;

export function isValidUnifiedDiff(patch: string): boolean {
  if (patch.length === 0) return false;
  return (
    DIFF_HEADER_PATTERN.test(patch) &&
    DIFF_HEADER_PLUS_PATTERN.test(patch) &&
    HUNK_HEADER_PATTERN.test(patch)
  );
}

export interface ValidatePatchPathsResult {
  valid: true;
}

export interface ValidatePatchPathsFailure {
  valid: false;
  reason: string;
}

export type ValidatePatchPathsReturn = ValidatePatchPathsResult | ValidatePatchPathsFailure;

export function validatePatchPaths(
  patch: string,
  worktreePath: string,
): ValidatePatchPathsReturn {
  const worktreeResolved = resolve(worktreePath);
  const lines = patch.split("\n");

  for (const line of lines) {
    let path: string | undefined;

    if (line.startsWith("--- a/")) {
      path = line.slice(6);
    } else if (line.startsWith("+++ b/")) {
      path = line.slice(6);
    }

    if (path === undefined) continue;

    // Allow /dev/null for deletions and creations
    if (path === "/dev/null") continue;

    // Reject absolute paths
    if (path.startsWith("/")) {
      return {
        valid: false,
        reason: `${path}: absolute path not allowed`,
      };
    }

    // Check for .. path-escape segments
    const segments = path.split("/");
    for (const segment of segments) {
      if (segment === "..") {
        return {
          valid: false,
          reason: `${path}: path-escape segment (..) not allowed`,
        };
      }
    }

    // Resolve and check if path is inside worktree
    const resolvedFilePath = resolve(worktreeResolved, path);
    const expectedPrefix = worktreeResolved + sep;

    if (!resolvedFilePath.startsWith(expectedPrefix) && resolvedFilePath !== worktreeResolved) {
      return {
        valid: false,
        reason: `${path}: resolves outside worktree`,
      };
    }
  }

  return { valid: true };
}
