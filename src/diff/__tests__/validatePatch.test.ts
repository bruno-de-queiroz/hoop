import { describe, it, expect } from "vitest";
import { isValidUnifiedDiff } from "../validatePatch.js";

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
