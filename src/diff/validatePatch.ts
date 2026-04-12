const DIFF_HEADER_PATTERN = /^---\s/m;
const DIFF_HEADER_PLUS_PATTERN = /^\+\+\+\s/m;
const HUNK_HEADER_PATTERN = /^@@\s/m;

export function isValidUnifiedDiff(patch: string): boolean {
  if (patch.length === 0) return false;
  return (
    DIFF_HEADER_PATTERN.test(patch) &&
    DIFF_HEADER_PLUS_PATTERN.test(patch) &&
    HUNK_HEADER_PATTERN.test(patch)
  );
}
