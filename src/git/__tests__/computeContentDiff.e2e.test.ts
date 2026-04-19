import { describe, it, expect } from "vitest";
import { computeContentDiff } from "../gitBranch.js";

describe("computeContentDiff (real git)", () => {
  it("returns empty string when contents are identical", async () => {
    const result = await computeContentDiff("file.txt", "same\n", "same\n");
    expect(result).toEqual({ ok: true, value: "" });
  });

  it("generates a valid unified diff from provided content", async () => {
    const oldContent = "line 1\nline 2\nline 3\n";
    const newContent = "line 1\nline modified\nline 3\n";

    const result = await computeContentDiff("src/app.ts", oldContent, newContent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify the patch contains correct file path headers
    expect(result.value).toContain("--- a/src/app.ts");
    expect(result.value).toContain("+++ b/src/app.ts");
    expect(result.value).toContain("@@");
    // Verify it contains the actual changes
    expect(result.value).toContain("-line 2");
    expect(result.value).toContain("+line modified");
  });

  it("does not contain temp file paths in output", async () => {
    const result = await computeContentDiff("file.txt", "old\n", "new\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toContain("hoop-diff-");
    expect(result.value).not.toContain("/tmp/");
  });

  it("handles file paths containing $ without corruption", async () => {
    const filePath = "src/$&_helper.ts";
    const result = await computeContentDiff(filePath, "old\n", "new\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain(`--- a/${filePath}`);
    expect(result.value).toContain(`+++ b/${filePath}`);
    expect(result.value).toContain(`diff --git a/${filePath} b/${filePath}`);
  });

  it("handles new file content (empty old)", async () => {
    const result = await computeContentDiff("new-file.ts", "", "content\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain("a/new-file.ts");
    expect(result.value).toContain("b/new-file.ts");
    expect(result.value).toContain("+content");
  });
});
