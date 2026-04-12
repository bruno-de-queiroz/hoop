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

  const checkResult = await applyGitPatch(worktreePath, patch, true);
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

  return { ok: true };
}
