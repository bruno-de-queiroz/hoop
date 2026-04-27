import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSkill(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), "utf-8");
}

describe("skill definitions", () => {
  it("/hoop:new defers settings to the MCP server's elicit form and preserves the output UX", () => {
    const content = readSkill("skills", "new", "SKILL.md");

    expect(content).toContain("hoop_create_session");
    expect(content).not.toContain("import { createSession }");
    expect(content).not.toContain("src/session/createSession");
    // The server drives the form — the skill must NOT prompt the user
    // with a numbered menu for execution target / governance mode.
    expect(content).not.toMatch(/Select execution target:/);
    expect(content).not.toMatch(/Host-Only.*Proponent-Side/);
    expect(content).toMatch(/elicit/i);
    expect(content).toContain("UserPromptSubmit");
    expect(content).toContain("admit or deny");
    expect(content).toContain("Session created!");
    expect(content).toContain("Share this code with peers");
  });

  it("/hoop:settings defers to the MCP server's elicit form and preserves the output UX", () => {
    const content = readSkill("skills", "settings", "SKILL.md");

    expect(content).toContain("hoop_set_settings");
    expect(content).not.toContain("hoop_set_mode");
    // The server drives the form — the skill must NOT parse a mode/threshold
    // arg or print a usage menu.
    expect(content).not.toMatch(/Usage: \/hoop:settings <mode>/);
    expect(content).not.toMatch(/Must be one of: host-only/);
    expect(content).toMatch(/elicit/i);
    expect(content).toContain("Governance mode set to:");
    expect(content).toContain("Approval threshold:");
  });

  it("/hoop:join uses the MCP join-session tool and preserves the prompt/output UX", () => {
    const content = readSkill("skills", "join", "SKILL.md");

    expect(content).toContain("hoop_join_session");
    expect(content).not.toContain("import { joinSession }");
    expect(content).not.toContain("src/session/joinSession");
    expect(content).toContain("Enter the host's listen address (multiaddr):");
    expect(content).toContain("Enter your email (for host admission):");
    expect(content).toContain("Connected to session!");
  });

  it("/hoop:agent uses MCP status/lock tools and Agent for sub-agent spawning", () => {
    const content = readSkill("skills", "agent", "SKILL.md");

    // Uses MCP tools, not internal TypeScript
    expect(content).toContain("hoop_get_status");
    expect(content).toContain("hoop_acquire_lock");
    expect(content).toContain("hoop_release_lock");
    expect(content).toContain("`Agent` tool");
    expect(content).not.toContain("import {");
    expect(content).not.toContain("src/session/");
    expect(content).not.toContain("src/mcp/");

    // Model parsing via --model flag
    expect(content).toContain("--model");
    expect(content).toContain("opus");
    expect(content).toContain("sonnet");
    expect(content).toContain("haiku");

    // Agent tool parameters
    expect(content).toContain("`description`:");
    expect(content).toContain("`model`:");
    expect(content).toContain("`prompt`:");

    // UX strings — happy path and error paths
    expect(content).toContain("Usage: /hoop:agent");
    expect(content).toContain("Unknown model:");
    expect(content).toContain("No active Hoop session");
    expect(content).toContain("Cannot start agent");
    expect(content).toContain("Agent completed. Lock released.");
  });

  it("/hoop:unlock uses the MCP force-unlock tool and includes confirmation UX", () => {
    const content = readSkill("skills", "unlock", "SKILL.md");

    expect(content).toContain("hoop_force_unlock");
    expect(content).toContain("hoop_lock_status");
    expect(content).not.toContain("import ");
    expect(content).toContain("Proceed? (y/n)");
    expect(content).toContain("Lock force-released successfully");
  });

  it("/hoop:leave is documented as harness-routed with a fallback path through hoop_leave_session", () => {
    const content = readSkill("skills", "leave", "SKILL.md");

    // The harness intercepts /hoop:leave via UserPromptSubmit hook +
    // SIGUSR2 — must be called out so future maintainers don't break it.
    expect(content).toMatch(/harness/i);
    expect(content).toMatch(/SIGUSR2/);
    expect(content).toMatch(/UserPromptSubmit/);

    // Fallback path still uses the MCP tool, in case the hook didn't fire.
    expect(content).toContain("hoop_leave_session");
    expect(content).toContain("hoop_get_status");
    expect(content).not.toContain("import ");

    // Result UX strings preserved
    expect(content).toContain("Left Hoop session");
    // Disambiguates from /hoop:unlock so users pick the right action
    expect(content).toContain("/hoop:unlock");
    expect(content).toContain("does NOT delete the worktree");
  });
});
