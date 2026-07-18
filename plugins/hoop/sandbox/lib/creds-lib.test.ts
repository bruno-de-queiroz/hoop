import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// The credential reconcile logic lives in a host-side bash lib
// (hooks/scripts/creds-lib.sh) shared by the launcher and the SessionStart/Stop
// hook. Its pure core is unit-tested in creds-lib.test.sh; this wrapper runs
// that shell suite under vitest so it's covered by CI (ubuntu ships bash + jq).
const SHELL_TEST = path.resolve(
  __dirname,
  "../../hooks/scripts/creds-lib.test.sh",
);

describe("creds-lib.sh reconcile core (shell suite)", () => {
  it("passes every reconcile assertion", () => {
    expect(existsSync(SHELL_TEST)).toBe(true);

    let out = "";
    try {
      out = execFileSync("bash", [SHELL_TEST], { encoding: "utf-8" });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(
        `creds-lib.test.sh failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`,
      );
    }

    // Passes report "pass=N fail=0"; on a host without jq the suite self-skips.
    expect(out).toMatch(/fail=0|SKIP: jq not available/);
  });
});
