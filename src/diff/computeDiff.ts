import { computeContentDiff, hashContent } from "../git/gitBranch.js";

export interface DiffResult {
  patch: string;
  baseHash: string;
  resultHash: string;
}

export async function computeFileDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): Promise<DiffResult> {
  const baseHash = hashContent(oldContent);
  const resultHash = hashContent(newContent);

  const diffResult = await computeContentDiff(filePath, oldContent, newContent);
  if (!diffResult.ok) {
    throw new Error(`Failed to compute diff: ${diffResult.error}`);
  }

  return { patch: diffResult.value, baseHash, resultHash };
}
