import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("listSlashCommands — cwd-scoped project commands", () => {
  let prevHome: string | undefined;
  let fakeHome: string;
  let projectCwd: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "sandbox-cmd-home-"));
    projectCwd = mkdtempSync(join(tmpdir(), "sandbox-cmd-project-"));
    process.env.HOME = fakeHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  function writeProjectCommand(cwd: string, name: string) {
    mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "commands", `${name}.md`),
      `---\ndescription: project command ${name}\n---\n# ${name}\n`
    );
  }

  it("includes commands from <cwd>/.claude/commands/ when cwd is provided", async () => {
    writeProjectCommand(projectCwd, "ship");
    const { listSlashCommands } = await import("./commands");
    const cmds = listSlashCommands(projectCwd).filter((c) => c.plugin === "project");
    expect(cmds.map((c) => c.name)).toEqual(["ship"]);
    expect(cmds[0].kind).toBe("command");
    expect(cmds[0].description).toBe("project command ship");
  });

  it("excludes project commands when no cwd is passed", async () => {
    writeProjectCommand(projectCwd, "ship");
    const { listSlashCommands } = await import("./commands");
    const names = listSlashCommands().map((c) => c.name);
    expect(names).not.toContain("ship");
  });
});
