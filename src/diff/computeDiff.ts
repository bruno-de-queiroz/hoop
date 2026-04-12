import { computeGitDiff, hashContent } from "../git/gitBranch.js";

export interface DiffResult {
  patch: string;
  baseHash: string;
  resultHash: string;
}

export async function computeFileDiff(
  worktreePath: string,
  filePath: string,
  oldContent: string,
  newContent: string,
): Promise<DiffResult> {
  const baseHash = hashContent(oldContent);
  const resultHash = hashContent(newContent);

  const diffResult = await computeGitDiff(worktreePath, filePath);
  if (!diffResult.ok) {
    throw new Error(`Failed to compute diff: ${diffResult.error}`);
  }

  return { patch: diffResult.value, baseHash, resultHash };
}
