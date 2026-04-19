import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { applyGitPatch, hashContent } from "../git/gitBranch.js";

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
