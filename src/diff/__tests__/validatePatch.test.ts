import { describe, it, expect } from "vitest";
import { isValidUnifiedDiff, validatePatchPaths } from "../validatePatch.js";

const VALID_PATCH = `diff --git a/file.txt b/file.txt
index 1234567..abcdef0 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line one
-line two
+line TWO
 line three`;

describe("isValidUnifiedDiff", () => {
  it("returns true for a valid unified diff", () => {
    expect(isValidUnifiedDiff(VALID_PATCH)).toBe(true);
  });

  it("returns true for a minimal valid diff", () => {
    const minimal = `--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-old
+new`;
    expect(isValidUnifiedDiff(minimal)).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isValidUnifiedDiff("")).toBe(false);
  });

  it("returns false for raw file content", () => {
    expect(isValidUnifiedDiff("hello world\nthis is a file\n")).toBe(false);
  });

  it("returns false for patch missing --- header", () => {
    const noMinus = `+++ b/file.txt
@@ -1 +1 @@
-old
+new`;
    expect(isValidUnifiedDiff(noMinus)).toBe(false);
  });

  it("returns false for patch missing +++ header", () => {
    const noPlus = `--- a/file.txt
@@ -1 +1 @@
-old
+new`;
    expect(isValidUnifiedDiff(noPlus)).toBe(false);
  });

  it("returns false for patch missing @@ hunk header", () => {
    const noHunk = `--- a/file.txt
+++ b/file.txt
-old
+new`;
    expect(isValidUnifiedDiff(noHunk)).toBe(false);
  });
});

describe("validatePatchPaths", () => {
  const worktreePath = "/tmp/worktree";

  it("rejects patch with +++ b/../../etc/passwd", () => {
    const patch = `--- a/file.txt
+++ b/../../etc/passwd
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("..");
    }
  });

  it("rejects patch with +++ b//etc/passwd (absolute path)", () => {
    const patch = `--- a/file.txt
+++ b//etc/passwd
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("absolute");
    }
  });

  it("rejects patch with +++ b/foo/../../../escape", () => {
    const patch = `--- a/file.txt
+++ b/foo/../../../escape
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("..");
    }
  });

  it("accepts patch with +++ b/legit/path.ts", () => {
    const patch = `--- a/file.txt
+++ b/legit/path.ts
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(true);
  });

  it("accepts patch with +++ b/foo..bar/baz.ts (weird filename, not path-escape)", () => {
    const patch = `--- a/file.txt
+++ b/foo..bar/baz.ts
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(true);
  });

  it("accepts patch with +++ /dev/null (deletion case)", () => {
    const patch = `--- a/file.txt
+++ /dev/null
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(true);
  });

  it("accepts patch with --- /dev/null (creation case)", () => {
    const patch = `--- /dev/null
+++ b/newfile.txt
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(true);
  });

  it("rejects patch with both headers, first one invalid", () => {
    const patch = `--- a/escape/../../bad
+++ b/legit/file.txt
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("..");
    }
  });

  it("rejects patch with both headers, second one invalid", () => {
    const patch = `--- a/legit/file.txt
+++ b/escape/../../bad
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("..");
    }
  });

  it("accepts patch with no path headers (empty patch)", () => {
    const patch = `@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(true);
  });

  it("accepts patch with nested valid paths", () => {
    const patch = `--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(true);
  });

  it("rejects patch attempting to write to parent directory", () => {
    const patch = `--- a/file.txt
+++ b/../outside.txt
@@ -1 +1 @@
-old
+new`;
    const result = validatePatchPaths(patch, worktreePath);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("..");
    }
  });
});
