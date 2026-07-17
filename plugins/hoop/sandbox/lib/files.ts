import { readdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { isAllowedCwd } from "./cwd-policy";

export interface FileEntry {
  /**
   * Path relative to the request `cwd`. For nested-path queries (e.g.
   * `q="docs/READ"`) this is the matched item under `docs/`, returned
   * as `docs/README.md` so the dashboard inserts the full mention.
   */
  name: string;
  isDir: boolean;
}

export class CwdPolicyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CwdPolicyError";
  }
}

/**
 * List entries under `cwd`, optionally filtered by `q`.
 *
 * The query supports two shapes:
 *   - `"foo"` — substring match on basenames in the cwd root.
 *   - `"sub/foo"` — descend into `sub/` (must be within the cwd) and
 *     substring-match on basenames there. The returned `name` includes
 *     the prefix so the caller inserts the full path (`sub/foo.md`).
 *
 * Directories sort first, then files, each group alphabetical. Hidden
 * entries (`.`-prefixed) are omitted unless the last query segment
 * starts with `.`.
 *
 * `cwd` is validated against the same policy as session creation. An
 * out-of-policy / non-existent / escaping path throws `CwdPolicyError`.
 */
export async function listFiles(opts: {
  cwd: string;
  q?: string;
  limit?: number;
}): Promise<FileEntry[]> {
  const policy = isAllowedCwd(opts.cwd);
  if (!policy.ok) throw new CwdPolicyError(policy.reason ?? "cwd not allowed");

  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const rawQuery = opts.q ?? "";

  // Split the query into "subpath/" + "leaf-query". Everything up to the
  // final `/` is interpreted as a literal subdirectory path under cwd;
  // the trailing segment is the substring matcher applied to entry names
  // at that depth.
  const slashIdx = rawQuery.lastIndexOf("/");
  const subRel = slashIdx >= 0 ? rawQuery.slice(0, slashIdx) : "";
  const leafQuery = (slashIdx >= 0 ? rawQuery.slice(slashIdx + 1) : rawQuery).toLowerCase();
  const showHidden = leafQuery.startsWith(".");

  // Resolve the target directory and reject paths that escape cwd.
  const targetDir = subRel ? join(opts.cwd, subRel) : opts.cwd;
  const normalized = normalize(targetDir);
  if (!isWithin(opts.cwd, normalized)) {
    throw new CwdPolicyError("path escapes cwd");
  }

  let raw: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    raw = (await readdir(normalized, { withFileTypes: true })) as unknown as typeof raw;
  } catch (e: any) {
    throw new CwdPolicyError(`cwd unreadable: ${e?.message ?? normalized}`);
  }

  const entries: FileEntry[] = [];
  for (const d of raw) {
    const baseName = String(d.name);
    if (!showHidden && baseName.startsWith(".")) continue;
    if (leafQuery && !baseName.toLowerCase().includes(leafQuery)) continue;
    const fullName = subRel ? `${subRel}/${baseName}` : baseName;
    entries.push({ name: fullName, isDir: d.isDirectory() });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries.slice(0, limit);
}

function isWithin(parent: string, child: string): boolean {
  const p = normalize(parent).replace(/\/+$/, "");
  const c = normalize(child).replace(/\/+$/, "");
  return c === p || c.startsWith(p + "/");
}

// Resolve a path relative to cwd, joining safely. Exported so the route
// handler can compose nested listings later if needed; for v1 we only
// list the cwd root.
export function resolveUnder(cwd: string, sub: string): string {
  return join(cwd, sub);
}
