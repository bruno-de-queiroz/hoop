import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { applyGitPatch, hashContent } from "../git/gitBranch.js";
import { validatePatchPaths } from "./validatePatch.js";

export interface PatchSuccess {
  ok: true;
}

export interface PatchFailure {
  ok: false;
  error: "base-hash-mismatch" | "patch-failed" | "result-hash-mismatch";
  message: string;
}

export type PatchResult = PatchSuccess | PatchFailure;

export async function applyFilePatch(
  worktreePath: string,
  filePath: string,
  patch: string,
  currentContent: string,
  expectedBaseHash: string,
  expectedResultHash: string,
): Promise<PatchResult> {
  const actualBaseHash = hashContent(currentContent);
  if (actualBaseHash !== expectedBaseHash) {
    return {
      ok: false,
      error: "base-hash-mismatch",
      message: `Base hash mismatch: expected ${expectedBaseHash}, got ${actualBaseHash}`,
    };
  }

  const resolvedPath = resolve(join(worktreePath, filePath));
  if (!resolvedPath.startsWith(resolve(worktreePath) + sep)) {
    return {
      ok: false,
      error: "patch-failed",
      message: `Invalid file path: ${filePath}`,
    };
  }

  // Validate patch headers don't contain path-traversal attempts
  const patchValidation = validatePatchPaths(patch, worktreePath);
  if (!patchValidation.valid) {
    return {
      ok: false,
      error: "patch-failed",
      message: `Patch path validation failed: ${patchValidation.reason}`,
    };
  }

  // Reject multi-file patches: applyFilePatch only validates the base hash
  // for the single `filePath` argument. A peer-crafted patch that references
  // additional files would slip past that check and modify them with no
  // base-content validation. Hoop's own computeContentDiff only ever produces
  // single-file patches, so rejecting multi-file is safe for legitimate use.
  const headerPaths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^(?:--- a\/|\+\+\+ b\/)(.+)$/);
    if (match && match[1] !== "/dev/null") {
      headerPaths.add(match[1]);
    }
  }
  if (headerPaths.size > 1) {
    return {
      ok: false,
      error: "patch-failed",
      message: `Multi-file patches not supported: patch references ${headerPaths.size} files (${Array.from(headerPaths).join(", ")}); only single-file patches are accepted.`,
    };
  }

  const checkResult = await applyGitPatch(worktreePath, patch, { check: true });
  if (!checkResult.ok) {
    return {
      ok: false,
      error: "patch-failed",
      message: `Dry-run failed: ${checkResult.error}`,
    };
  }

  const applyResult = await applyGitPatch(worktreePath, patch);
  if (!applyResult.ok) {
    return {
      ok: false,
      error: "patch-failed",
      message: `Apply failed: ${applyResult.error}`,
    };
  }

  let resultContent: string;
  try {
    resultContent = await readFile(resolvedPath, "utf-8");
  } catch {
    const reverseResult = await applyGitPatch(worktreePath, patch, { reverse: true });
    const rollbackNote = reverseResult.ok ? "" : ` (rollback failed: ${reverseResult.error})`;
    return {
      ok: false,
      error: "patch-failed",
      message: `Cannot read patched file: ${filePath}${rollbackNote}`,
    };
  }

  const actualResultHash = hashContent(resultContent);
  if (actualResultHash !== expectedResultHash) {
    const reverseResult = await applyGitPatch(worktreePath, patch, { reverse: true });
    const rollbackNote = reverseResult.ok ? "" : ` (rollback failed: ${reverseResult.error})`;
    return {
      ok: false,
      error: "result-hash-mismatch",
      message: `Result hash mismatch: expected ${expectedResultHash}, got ${actualResultHash}${rollbackNote}`,
    };
  }

  return { ok: true };
}
