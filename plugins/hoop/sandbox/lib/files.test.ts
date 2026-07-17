import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./cwd-policy", () => ({
  isAllowedCwd: (p: string) => {
    if (p.startsWith("/forbidden")) return { ok: false, reason: "policy: out of scope" };
    return { ok: true };
  },
}));

const { listFiles, CwdPolicyError } = await import("./files");

describe("listFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "files-test-"));
    writeFileSync(join(dir, "README.md"), "");
    writeFileSync(join(dir, "package.json"), "");
    writeFileSync(join(dir, "tsconfig.json"), "");
    writeFileSync(join(dir, ".env"), "");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "lib"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists entries with directories first, alphabetical within group, skipping hidden", async () => {
    const entries = await listFiles({ cwd: dir });
    // localeCompare sort: directories first (alphabetical), then files
    // (alphabetical, locale-aware so case-insensitive in en-US).
    expect(entries.slice(0, 2).map((e) => e.name)).toEqual(["lib", "src"]);
    expect(entries.slice(2).map((e) => e.name).sort()).toEqual(
      ["README.md", "package.json", "tsconfig.json"].sort(),
    );
    expect(entries.find((e) => e.name === ".env")).toBeUndefined();
    expect(entries.find((e) => e.name === "lib")?.isDir).toBe(true);
    expect(entries.find((e) => e.name === "README.md")?.isDir).toBe(false);
  });

  it("filters by case-insensitive substring on the basename", async () => {
    const entries = await listFiles({ cwd: dir, q: "json" });
    expect(entries.map((e) => e.name)).toEqual(["package.json", "tsconfig.json"]);
  });

  it("respects the limit", async () => {
    const entries = await listFiles({ cwd: dir, limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("clamps limit between 1 and 100", async () => {
    const tiny = await listFiles({ cwd: dir, limit: 0 });
    expect(tiny).toHaveLength(1);
  });

  it("includes hidden entries only when the query starts with a dot", async () => {
    const noHidden = await listFiles({ cwd: dir });
    expect(noHidden.find((e) => e.name === ".env")).toBeUndefined();

    const withHidden = await listFiles({ cwd: dir, q: "." });
    expect(withHidden.find((e) => e.name === ".env")).toBeDefined();
  });

  it("throws CwdPolicyError for an off-policy cwd", async () => {
    await expect(listFiles({ cwd: "/forbidden/path" })).rejects.toBeInstanceOf(CwdPolicyError);
  });

  it("throws CwdPolicyError for a non-existent cwd", async () => {
    await expect(listFiles({ cwd: join(dir, "does-not-exist") })).rejects.toBeInstanceOf(
      CwdPolicyError,
    );
  });

  it("descends into subdirectories when the query carries a slash", async () => {
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "src", "util.ts"), "");
    const entries = await listFiles({ cwd: dir, q: "src/index" });
    expect(entries.map((e) => e.name)).toEqual(["src/index.ts"]);
  });

  it("lists all entries under a subdirectory when query is 'sub/'", async () => {
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "src", "util.ts"), "");
    const entries = await listFiles({ cwd: dir, q: "src/" });
    expect(entries.map((e) => e.name).sort()).toEqual(["src/index.ts", "src/util.ts"]);
  });

  it("rejects queries that try to escape the cwd via ..", async () => {
    await expect(listFiles({ cwd: dir, q: "../README" })).rejects.toBeInstanceOf(
      CwdPolicyError,
    );
  });
});
